export interface StudySegment {
    type: "text" | "math" | "code" | "inlineCode";
    text: string;
    display: boolean;
}

const unicodeLatex: Record<string, string> = {
    "∅": "\\varnothing",
    ℕ: "\\mathbb{N}",
    ℤ: "\\mathbb{Z}",
    ℚ: "\\mathbb{Q}",
    ℝ: "\\mathbb{R}",
    ℂ: "\\mathbb{C}",
    "∈": "\\in",
    "∉": "\\notin",
    "∋": "\\ni",
    "⊂": "\\subset",
    "⊃": "\\supset",
    "⊆": "\\subseteq",
    "⊇": "\\supseteq",
    "∪": "\\cup",
    "∩": "\\cap",
    "∞": "\\infty",
    "≤": "\\le",
    "≥": "\\ge",
    "≠": "\\ne",
    "≈": "\\approx",
    "≡": "\\equiv",
    "±": "\\pm",
    "×": "\\times",
    "÷": "\\div",
    "·": "\\cdot",
    "√": "\\sqrt",
    "∑": "\\sum",
    "∏": "\\prod",
    "∫": "\\int",
    "∀": "\\forall",
    "∃": "\\exists",
    "¬": "\\neg",
    "∧": "\\land",
    "∨": "\\lor",
    "⇒": "\\Rightarrow",
    "⇔": "\\Leftrightarrow",
    "→": "\\to",
    "←": "\\leftarrow",
    "↔": "\\leftrightarrow",
};

function normalizeMath(text: string): string {
    return text
        .replace(
            /[⁰¹²³⁴⁵⁶⁷⁸⁹]+/g,
            (digits) =>
                `^{${Array.from(digits, (digit) => "⁰¹²³⁴⁵⁶⁷⁸⁹".indexOf(digit)).join("")}}`,
        )
        .replace(
            /[∅ℕℤℚℝℂ∈∉∋⊂⊃⊆⊇∪∩∞≤≥≠≈≡±×÷·√∑∏∫∀∃¬∧∨⇒⇔→←↔]/g,
            (symbol) => `${unicodeLatex[symbol]} `,
        );
}

function escaped(text: string, index: number): boolean {
    let slashes = 0;
    while (index > 0 && text[--index] === "\\") slashes++;
    return slashes % 2 === 1;
}

function escapeSetBraces(text: string): string {
    const groups: boolean[] = [];
    return text
        .split("")
        .map((character, index) => {
            if (character === "{") {
                // Script braces group their whole expression: R_{>0}, x^{n+1}.
                // Nested braces inside a script remain TeX groups as well.
                const script =
                    groups.at(-1) === true ||
                    /[_^]\s*$/.test(text.slice(0, index));
                groups.push(script);
                return script ? character : "\\{";
            }
            if (character === "}") return groups.pop() ? character : "\\}";
            return character;
        })
        .join("");
}

// Compatibility for saved questions written before the explicit LaTeX contract.
// Only recognizable notation is inferred. Prose and code are never sent as math.
function legacyMath(text: string, standaloneMath: boolean): StudySegment[] {
    const tokens = Array.from(
        text.matchAll(
            /\\[a-zA-Z]+(?:[ \t]*\{(?:[^{}]|\{[^{}]*\})*\})*|[\p{L}0-9]+(?:[.,]\d+)?|[^\s]/gu,
        ),
    );
    const isAtom = (token: string) =>
        /^(?:\\[a-zA-Z]+[\s\S]*|\d+(?:[.,]\d+)?[a-zA-Z]?|[a-zA-Zα-ωΑ-Ω]|sin|cos|tan|log|ln|exp|lim)$/u.test(
            token,
        );
    const isSymbol = (token: string) =>
        /^[+\-*/=<>^_()[\]{},|∈∉∋⊂⊃⊆⊇∪∩∅ℕℤℚℝℂ∞≤≥≠≈≡±×÷·√∑∏∫∀∃¬∧∨⇒⇔→←↔²³⁰¹⁴⁵⁶⁷⁸⁹]$/u.test(
            token,
        );
    const parts: StudySegment[] = [];
    let previous = 0;
    let index = 0;
    while (index < tokens.length) {
        const first = tokens[index];
        if (!isAtom(first[0]) && !isSymbol(first[0])) {
            index++;
            continue;
        }
        let end = index + 1;
        while (
            end < tokens.length &&
            /^[ \t]*$/.test(
                text.slice(
                    tokens[end - 1].index! + tokens[end - 1][0].length,
                    tokens[end].index,
                ),
            ) &&
            (isAtom(tokens[end][0]) || isSymbol(tokens[end][0]))
        )
            end++;
        // A sentence separator belongs to the surrounding prose.
        while (end > index && tokens[end - 1][0] === ",") end--;
        if (end === index) {
            index++;
            continue;
        }
        const startOffset = first.index!;
        const endOffset = tokens[end - 1].index! + tokens[end - 1][0].length;
        const candidate = text.slice(startOffset, endOffset);
        const atoms = tokens
            .slice(index, end)
            .filter((token) => isAtom(token[0]));
        const unmistakable =
            /\\[a-zA-Z]+|[α-ωΑ-Ω∈∉∋⊂⊃⊆⊇∪∩∅ℕℤℚℝℂ∞≤≥≠≈≡±×÷·√∑∏∫∀∃¬∧∨⇒⇔→←↔²³⁰¹⁴⁵⁶⁷⁸⁹]/u.test(
                candidate,
            );
        const expression =
            atoms.length >= 2 && /[=<>+*/^_]|\S\s*-\s*\S/.test(candidate);
        const interval = /^[[(]\s*-?(?:\d|∞)[\s\S]*,[\s\S]*[)\]]$/.test(
            candidate,
        );
        const standalone =
            standaloneMath &&
            candidate.trim() === text.trim() &&
            atoms.length > 0;
        if (unmistakable || expression || interval || standalone) {
            if (startOffset > previous)
                parts.push({
                    type: "text",
                    text: text.slice(previous, startOffset),
                    display: false,
                });
            const latex = candidate.includes("\\")
                ? candidate
                : escapeSetBraces(candidate);
            parts.push({
                type: "math",
                text: normalizeMath(latex),
                display: false,
            });
            previous = endOffset;
        }
        index = end;
    }
    if (previous < text.length)
        parts.push({
            type: "text",
            text: text.slice(previous),
            display: false,
        });
    return parts;
}

export function splitStudyText(
    text: string,
    standaloneMath = false,
): StudySegment[] {
    const parts: StudySegment[] = [];
    let previous = 0;
    let index = 0;
    while (index < text.length) {
        if (escaped(text, index)) {
            index++;
            continue;
        }
        const fence = text.startsWith("```", index);
        const code = text[index] === "`";
        const opener = fence
            ? "```"
            : code
              ? "`"
              : ["$$", "\\[", "\\(", "$"].find((value) =>
                    text.startsWith(value, index),
                );
        if (!opener) {
            index++;
            continue;
        }
        const closer =
            opener === "\\[" ? "\\]" : opener === "\\(" ? "\\)" : opener;
        let end = text.indexOf(closer, index + opener.length);
        while (end !== -1 && escaped(text, end))
            end = text.indexOf(closer, end + closer.length);
        if (end === -1) {
            index += opener.length;
            continue;
        }
        let body = text.slice(index + opener.length, end);
        if (
            !body ||
            (opener === "$" && (body.includes("\n") || body.trim() !== body))
        ) {
            index += opener.length;
            continue;
        }
        if (index > previous)
            parts.push(
                ...legacyMath(text.slice(previous, index), standaloneMath),
            );
        if (fence) body = body.slice(body.indexOf("\n") + 1);
        parts.push({
            type: fence ? "code" : code ? "inlineCode" : "math",
            text: code ? body : normalizeMath(body),
            display: opener === "$$" || opener === "\\[",
        });
        index = end + closer.length;
        previous = index;
    }
    if (previous < text.length)
        parts.push(...legacyMath(text.slice(previous), standaloneMath));
    return parts;
}
