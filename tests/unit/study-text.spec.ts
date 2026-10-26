import { expect, test } from "@playwright/test";
import katex from "katex";
import { splitStudyText } from "../../src/lib/study/text";

test("math delimiters preserve prose, inline notation, and multiline equations", () => {
    const parts = splitStudyText(String.raw`Find $x$ using \(\frac{1}{2}\).
$$x^2 = 4$$ and \[x = \pm 2\]`);
    expect(parts.filter((part) => part.type === "math")).toEqual([
        { type: "math", text: "x", display: false },
        { type: "math", text: String.raw`\frac{1}{2}`, display: false },
        { type: "math", text: "x^2 = 4", display: true },
        { type: "math", text: String.raw`x = \pm 2`, display: true },
    ]);
    expect(parts[0]).toMatchObject({ type: "text", text: "Find " });
});

test("legacy mathematical expressions and choice-only symbols render with KaTeX", () => {
    for (const text of [
        "Does x ∈ ℝ imply x² ≥ 0?",
        String.raw`Calculate \frac{1}{2} + \frac{1}{4}.`,
        "Solve x^2 + 2x = 0.",
        "Consider [0,4) and ∅.",
        "α ≤ β",
    ]) {
        const parts = splitStudyText(text);
        const math = parts.filter((part) => part.type === "math");
        expect(math.length, text).toBeGreaterThan(0);
        for (const part of math)
            expect(() =>
                katex.renderToString(part.text, {
                    throwOnError: true,
                    trust: false,
                }),
            ).not.toThrow();
    }
    for (const text of ["A", "4", "{1,2}", "[0,4)", "∅"])
        expect(
            splitStudyText(text, true).every((part) => part.type === "math"),
            text,
        ).toBe(true);
    expect(splitStudyText("{1,2}", true)[0].text).toBe(String.raw`\{1,2\}`);
});

test("legacy number-set subscripts and powers keep grouping braces while actual sets stay visible", () => {
    const parts = splitStudyText("Miten ℝ_{>0} ja ℝ_{≥0} eroavat?");
    const math = parts.filter((part) => part.type === "math");
    expect(math).toHaveLength(2);
    expect(math[0].text).toBe(String.raw`\mathbb{R} _{>0}`);
    expect(math[1].text).toBe(String.raw`\mathbb{R} _{\ge 0}`);
    for (const source of [
        "ℝ_{>0}",
        "ℝ_{≥0}",
        "x^{n+1}",
        "{x ∈ ℝ_{>0}}",
        String.raw`\mathbb{R}_{>0}`,
        String.raw`$\mathbb{R}_{\ge 0}$`,
    ]) {
        const math = splitStudyText(source, true).filter(
            (part) => part.type === "math",
        );
        expect(math).toHaveLength(1);
        const html = katex.renderToString(math[0].text, {
            throwOnError: true,
            trust: false,
        });
        expect(html).toMatch(/<msub>|<msup>/);
        expect(math[0].text).not.toMatch(/[_^]\\\{/);
    }
    expect(splitStudyText("{x ∈ ℝ_{>0}}", true)[0].text).toBe(
        String.raw`\{x \in  \mathbb{R} _{>0}\}`,
    );
});

test("code, prose, escaped dollars, and HTML stay literal", () => {
    const text =
        'Use `x ∈ ℝ` and code:\n```js\nconst x = "$5";\n```\nCosts \\$5 and \\$10. <script>alert("x")</script>';
    const parts = splitStudyText(text);
    expect(parts.filter((part) => part.type === "math")).toHaveLength(0);
    expect(parts.find((part) => part.type === "inlineCode")?.text).toBe(
        "x ∈ ℝ",
    );
    expect(parts.find((part) => part.type === "code")?.text).toContain(
        'const x = "$5";',
    );
    expect(splitStudyText("Choose the correct answer.", true)).toEqual([
        { type: "text", text: "Choose the correct answer.", display: false },
    ]);
});
