import { StateField, type EditorState } from "@codemirror/state";
import {
    Decoration,
    EditorView,
    WidgetType,
    type DecorationSet,
} from "@codemirror/view";
import katex from "katex";
import "katex/dist/katex.min.css";

export interface AnswerEquation {
    from: number;
    to: number;
    latex: string;
    display: boolean;
}

function escaped(text: string, position: number): boolean {
    let slashes = 0;
    while (position > 0 && text[--position] === "\\") slashes++;
    return slashes % 2 === 1;
}

export function findAnswerEquations(text: string): AnswerEquation[] {
    const equations: AnswerEquation[] = [];
    let position = 0;
    while (position < text.length) {
        if (escaped(text, position)) {
            position++;
            continue;
        }
        const opener = ["```", "`", "$$", "\\[", "\\(", "$"].find((token) =>
            text.startsWith(token, position),
        );
        if (!opener) {
            position++;
            continue;
        }
        const closer =
            opener === "\\[" ? "\\]" : opener === "\\(" ? "\\)" : opener;
        let end = text.indexOf(closer, position + opener.length);
        while (end >= 0 && escaped(text, end))
            end = text.indexOf(closer, end + closer.length);
        if (end < 0) {
            if (opener.startsWith("`")) break;
            position += opener.length;
            continue;
        }
        const latex = text.slice(position + opener.length, end);
        if (
            !opener.startsWith("`") &&
            latex.trim() &&
            (opener !== "$" || !latex.includes("\n"))
        )
            equations.push({
                from: position,
                to: end + closer.length,
                latex,
                display: opener === "$$" || opener === "\\[",
            });
        position = end + closer.length;
    }
    return equations;
}

class EquationWidget extends WidgetType {
    constructor(
        readonly equation: AnswerEquation,
        readonly readOnly: boolean,
    ) {
        super();
    }
    eq(other: EquationWidget): boolean {
        return (
            this.readOnly === other.readOnly &&
            this.equation.from === other.equation.from &&
            this.equation.to === other.equation.to &&
            this.equation.latex === other.equation.latex &&
            this.equation.display === other.equation.display
        );
    }
    toDOM(): HTMLElement {
        const element = document.createElement("span");
        element.dataset.answerEquation = "";
        element.dataset.from = String(this.equation.from);
        element.dataset.to = String(this.equation.to);
        element.contentEditable = "false";
        element.className =
            "mx-0.5 inline-block max-w-full overflow-x-auto align-middle text-text-primary [&_.katex-display]:m-0 [&_.katex-display]:py-1";
        if (!this.readOnly) {
            element.classList.add(
                "cursor-pointer",
                "rounded",
                "hover:bg-hover",
            );
            element.tabIndex = 0;
            element.setAttribute("role", "button");
            element.setAttribute(
                "aria-label",
                `Edit equation: ${this.equation.latex}`,
            );
            element.title = "Click to edit equation";
        }
        katex.render(this.equation.latex, element, {
            displayMode: this.equation.display,
            throwOnError: false,
            trust: false,
            strict: "ignore",
            errorColor: "var(--color-danger)",
        });
        return element;
    }
    ignoreEvent(): boolean {
        return false;
    }
}

function decorate(state: EditorState): DecorationSet {
    return Decoration.set(
        findAnswerEquations(state.doc.toString()).map((equation) =>
            Decoration.replace({
                widget: new EquationWidget(equation, state.readOnly),
                inclusive: false,
            }).range(equation.from, equation.to),
        ),
    );
}

export const answerMath = StateField.define<DecorationSet>({
    create: decorate,
    update: (decorations, transaction) =>
        transaction.docChanged || transaction.reconfigured
            ? decorate(transaction.state)
            : decorations,
    provide: (field) => [
        EditorView.decorations.from(field),
        EditorView.atomicRanges.of((view) => view.state.field(field)),
    ],
});
