import { NDKEvent, NDKKind } from '@nostr-dev-kit/ndk';
import { useNDK } from './ndk';
import { NDKEventWithFrom } from './subscribe';
import { useNDKSessionStore } from '../stores/session';

const useNDKSession = () => {
    const init = useNDKSessionStore(s => s.init);
    const mutePubkey = useNDKSessionStore(s => s.mutePubkey);

    return { init, mutePubkey };
}

const useFollows = () => useNDKSessionStore(s => s.follows);
const useMuteList = () => useNDKSessionStore(s => s.muteList);
const useSessionEvents = () => useNDKSessionStore(s => s.events);
const useWOT = () => useNDKSessionStore(s => s.wot);

/**
 * This hook allows you to get a specific kind, wrapped in the event class you provide.
 * @param EventClass 
 * @param kind 
 * @param opts.create - If true, and the event kind is not found, an unpublished event will be provided.
 * @returns 
 */
const useNDKSessionEventKind = <T extends NDKEvent>(
    EventClass: NDKEventWithFrom<any>,
    kind: NDKKind,
    { create }: { create: boolean } = { create: false }
): T | undefined => {
    const { ndk } = useNDK();
    const events = useNDKSessionStore(s => s.events);
    const kindEvents = events.get(kind) || [];
    const firstEvent = kindEvents[0];

    if (create && !firstEvent) {
        const event = new EventClass(ndk, { kind });
        event.kind = kind;
        events.set(kind, [event]);
        return event;
    }

    return firstEvent ? EventClass.from(firstEvent) : undefined;
};

const useNDKSessionEvents = <T extends NDKEvent>(
    kinds: NDKKind[],
    eventClass?: NDKEventWithFrom<any>,
): T[] => {
    const events = useNDKSessionStore(s => s.events);
    let allEvents = kinds.flatMap((kind) => events.get(kind) || []);

    if (kinds.length > 1) allEvents = allEvents.sort((a, b) => a.created_at - b.created_at);

    // remove deleted events if replaceable
    allEvents = allEvents.filter((e) => !e.isReplaceable() || !e.hasTag('deleted'));

    return allEvents.map((e) => eventClass ? eventClass.from(e) : e as T);
};

export {
    useFollows,
    useMuteList,
    useSessionEvents,
    useWOT,
    useNDKSessionEventKind,
    useNDKSessionEvents,
    useNDKSession,
};