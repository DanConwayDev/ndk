import { CashuWallet, CashuMint, Proof, MeltQuoteState } from "@cashu/cashu-ts";
import { NDKEvent, NDKTag, NDKUser, NDKZapDetails, type LnPaymentInfo } from "@nostr-dev-kit/ndk";
import type { NDKCashuPay } from "../pay";
import { rollOverProofs, type TokenSelection } from "../proofs";
import type { MintUrl } from "../mint/utils";
import { NDKCashuWallet } from "../wallet";
import { NDKWalletChange } from "../history";

export async function payLn(
    this: NDKCashuPay,
    payment: NDKZapDetails<LnPaymentInfo>,
    useMint?: MintUrl,
): Promise<string | undefined> {
    this.debug("payLn %o", this.info);
    
    const mintBalances = this.wallet.mintBalances;
    const amount = this.getAmount() / 1000; // convert msat to sat
    const data = this.info as LnPaymentInfo;
    if (!data.pr) throw new Error("missing pr");

    return new Promise<string>((resolve, reject) => {
        const eligibleMints = getEligibleMints(mintBalances, amount, useMint, this.debug);

        if (eligibleMints.length === 0) {
            handleInsufficientBalance(amount, data.pr, this.wallet, this.debug, reject);
            return;
        }

        attemptPaymentWithEligibleMints(
            eligibleMints,
            data.pr,
            amount,
            this.wallet,
            payment,
            this.debug,
            resolve,
            reject
        );
    });
}

function getEligibleMints(
    mintBalances: Record<string, number>,
    amount: number,
    useMint: MintUrl | undefined,
    debug: NDKCashuPay["debug"]
): string[] {
    return Object.entries(mintBalances)
        .filter(([mint, balance]) => {
            if (useMint && mint !== useMint) return false;
            if (balance < amount) {
                debug("mint %s has insufficient balance %d", mint, balance, amount);
                return false;
            }
            return true;
        })
        .map(([mint]) => mint);
}

function handleInsufficientBalance(
    amount: number,
    pr: string,
    wallet: NDKCashuPay["wallet"],
    debug: NDKCashuPay["debug"],
    reject: (reason: string) => void
): void {
    wallet.emit("insufficient_balance", { amount, pr });
    debug("no mint with sufficient balance found");
    reject("no mint with sufficient balance found");
}

async function attemptPaymentWithEligibleMints(
    eligibleMints: string[],
    pr: string,
    amount: number,
    wallet: NDKCashuPay["wallet"],
    payment: NDKZapDetails<LnPaymentInfo>,
    debug: NDKCashuPay["debug"],
    resolve: (value: string) => void,
    reject: (reason: string, errors: Record<string, string>) => void
): Promise<void> {
    const errors: Record<string, string> = {};

    for (const mint of eligibleMints) {
        try {
            const result = await executePayment(mint, pr, amount, wallet, payment, debug);
            if (result) {
                resolve(result);
                return;
            }
        } catch (error: any) {
            debug("Failed to execute payment for mint %s: %s", mint, error);
            errors[mint] = error.message;
        }
    }

    reject("Failed to pay with any mint", errors);
}

/**
 * Attempts to pay using a selected set of Cashu tokens.
 *
 * @param selection - The TokenSelection object containing the chosen proofs and quote for the payment.
 * @param pr - The Lightning Network payment request (invoice) to pay.
 * @param wallet - The NDKCashuPay wallet instance.
 * @param debug - The debug function for logging.
 * @returns A Promise that resolves to the payment preimage as a string if successful, or null if the payment fails.
 *
 * @throws Will throw an error if the payment fails due to network issues or other problems.
 *
 * This function performs the following steps:
 * 1. Creates a new CashuWallet instance for the specific mint.
 * 2. Attempts to pay the Lightning invoice using the selected proofs.
 * 3. If successful, it rolls over any change proofs.
 * 4. If the proofs are already spent, it rolls over the selection without change.
 * 5. Logs the process and any errors for debugging purposes.
 */
async function executePayment(
    mint: string,
    pr: string,
    amount: number,
    wallet: NDKCashuWallet,
    payment: NDKZapDetails<LnPaymentInfo>,
    debug: NDKCashuPay["debug"]
): Promise<string | undefined | null> {
    const _wallet = await wallet.walletForMint(mint);
    if (!_wallet) throw new Error("unable to load wallet for mint " + mint);
    const mintProofs = wallet.proofsForMint(mint);

    // Add up the amounts of the proofs
    const amountAvailable = mintProofs.reduce((acc, proof) => acc + proof.amount, 0);
    if (amountAvailable < amount) return null;

    try {
        const meltQuote = await _wallet.createMeltQuote(pr);
        const amountToSend = meltQuote.amount + meltQuote.fee_reserve;

        const res = _wallet.selectProofsToSend(mintProofs, amountToSend);

        const meltResult = await _wallet.meltProofs(meltQuote, mintProofs);
        debug("Melt result: %o", meltResult);

        const fee = calculateFee(amount, mintProofs, meltResult.change);

        function calculateFee(sentAmount: number, proofs: Proof[], change: Proof[]) {
            let fee = -sentAmount;
            for (const proof of proofs) fee += proof.amount;
            for (const proof of change) fee -= proof.amount;
            return fee;
        }

        // generate history event
        if (meltResult.quote.state === MeltQuoteState.PAID && meltResult.quote.payment_preimage) {
            debug("Payment successful");
            const { destroyedTokens, createdToken } = await rollOverProofs(
                {
                    usedProofs: mintProofs,
                    movedProofs: [
                        ...meltResult.keep,
                        ...meltResult.change
                    ],
                    usedTokens: mintProofs,
                    mint,
                },
                [],
                mint,
                wallet
            );
            const historyEvent = new NDKWalletChange(wallet.ndk);
            historyEvent.destroyedTokens = destroyedTokens;
            if (createdToken) historyEvent.createdTokens = [createdToken];
            if (wallet.event) historyEvent.tag(wallet.event);
            historyEvent.direction = 'out';
            historyEvent.description = payment.paymentDescription;
            
            if (payment.target) {
                let tag: NDKTag | undefined;
                
                if (payment.target instanceof NDKEvent) {
                    tag = payment.target.tagReference();
                } else if (payment.target instanceof NDKUser && !payment.recipientPubkey) {
                    tag = ['p', payment.target.pubkey];
                }

                if (tag) {
                    console.log("adding tag", tag);
                    historyEvent.tags.push(tag);
                }
            }

            if (payment.recipientPubkey) {
                historyEvent.tags.push(['p', payment.recipientPubkey]);
            }

            historyEvent.tags.push(['preimage', meltResult.quote.payment_preimage]);
            historyEvent.amount = meltResult.quote.amount;
            historyEvent.fee = fee;
            historyEvent.publish(wallet.relaySet);

            return meltResult.quote.payment_preimage;
        }

        return meltResult.quote.payment_preimage;
    } catch (e) {
        if (e instanceof Error) {
            debug("Failed to pay with mint %s", e.message);
            // if (e.message.match(/already spent/i)) {
            //     debug("Proofs already spent, rolling over");
            //     rollOverProofs(selection, [], selection.mint, wallet);
            // }
            throw e;
        }

        return null;
    }
}