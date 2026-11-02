import type { PracticeSettings } from "$lib/types";
import type { SyncedNote } from "$lib/types/notes";

export function includedBroadTopics(
    note: SyncedNote,
    settings: PracticeSettings,
) {
    return note.topics.filter(
        (topic) =>
            !("text" in topic) &&
            !settings.excludeAllTopics &&
            (!settings.topicIds.length ||
                settings.topicIds.includes(topic.id) ||
                note.topics.some(
                    (child) =>
                        "broadTopicId" in child &&
                        child.broadTopicId === topic.id &&
                        settings.topicIds.includes(child.id),
                )),
    );
}

export function withBroadTopics(
    settings: PracticeSettings,
    topicIds: string[],
): PracticeSettings {
    return { ...settings, topicIds, excludeAllTopics: topicIds.length === 0 };
}
