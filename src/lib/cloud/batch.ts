/** Leave room for the envelope below the API's 10 MiB request limit. */
export function syncBatch<T>(
    items: T[],
    maxCount = 500,
    byteBudget = 8 * 1024 * 1024,
): T[] {
    const result: T[] = [];
    let bytes = 2;
    for (const item of items) {
        const size =
            new TextEncoder().encode(JSON.stringify(item)).byteLength + 1;
        if (size > 9 * 1024 * 1024)
            throw new Error(
                "A saved answer or question exceeds the server upload limit. Reduce its attachments before syncing.",
            );
        if (
            result.length &&
            (result.length >= maxCount || bytes + size > byteBudget)
        )
            break;
        result.push(item);
        bytes += size;
    }
    return result;
}
