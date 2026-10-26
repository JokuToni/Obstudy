export interface EquationCommand {
    latex: string;
}

export interface MathField {
    latex(): string;
    latex(value: string): MathField;
    cmd(command: string): MathField;
    select(): MathField;
    focus(): MathField;
    revert(): void;
}

interface MathQuillInterface {
    MathField(
        element: HTMLElement,
        options: {
            spaceBehavesLikeTab: boolean;
            restrictMismatchedBrackets: boolean;
            autoCommands: string;
            substituteTextarea: () => HTMLTextAreaElement;
            handlers: {
                edit: (field: MathField) => void;
                enter: () => void;
            };
        },
    ): MathField;
}

let loading: Promise<MathQuillInterface> | undefined;

export function loadMathQuill(): Promise<MathQuillInterface> {
    loading ??= (async () => {
        const mathWindow = window as Window & {
            jQuery?: unknown;
            MathQuill?: {
                getInterface: (version: number) => MathQuillInterface;
            };
        };
        const jquery = await import("jquery");
        mathWindow.jQuery = jquery.default;
        await import("mathquill/build/mathquill.js");
        if (!mathWindow.MathQuill)
            throw new Error("The equation editor could not be loaded.");
        return mathWindow.MathQuill.getInterface(2);
    })().catch((error) => {
        loading = undefined;
        throw error;
    });
    return loading;
}
