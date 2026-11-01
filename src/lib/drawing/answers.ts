import type { DrawingAnswer, ExerciseDraftAnswer } from "$lib/types/exercises";

export function hasDrawing(drawing?: DrawingAnswer | null): boolean {
    return !!drawing?.elements.some((element) => !element.isDeleted);
}

export function hasAnswer(
    answer: Pick<ExerciseDraftAnswer, "text" | "drawing">,
): boolean {
    return !!answer.text.trim() || hasDrawing(answer.drawing);
}

export const drawingAiReason =
    "Drawing answers need self grading. AI grading currently supports text answers only.";

let runtime: Promise<typeof import("@excalidraw/excalidraw")> | undefined;
export function loadDrawingRuntime() {
    (
        window as Window & { EXCALIDRAW_ASSET_PATH?: string }
    ).EXCALIDRAW_ASSET_PATH = "/excalidraw/";
    return (runtime ??= import("@excalidraw/excalidraw"));
}
