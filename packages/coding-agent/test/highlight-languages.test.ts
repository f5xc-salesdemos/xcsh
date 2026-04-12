/**
 * Per-language syntax highlighting verification tests.
 *
 * Each test runs a representative code sample through the native highlighter
 * and verifies that key tokens receive the correct ANSI color codes matching
 * the dark theme (VS Code Dark+ inspired):
 *
 *   comment:     #6A9955  (green)
 *   keyword:     #569CD6  (blue)
 *   function:    #DCDCAA  (yellow)
 *   variable:    #9CDCFE  (light blue)
 *   string:      #CE9178  (terracotta)
 *   number:      #B5CEA8  (light green)
 *   type:        #4EC9B0  (teal)
 *   operator:    #D4D4D4  (light gray)
 *   punctuation: #D4D4D4  (light gray)
 *   control:     #C586C0  (purple)
 */
import { describe, expect, it } from "bun:test";
import { highlightCode as nativeHighlightCode } from "@f5xc-salesdemos/pi-natives";

// Dark theme ANSI escape sequences for truecolor (24-bit)
// Format: \x1b[38;2;R;G;Bm
const COLORS = {
	comment: "\x1b[38;2;106;153;85m", // #6A9955
	keyword: "\x1b[38;2;86;156;214m", // #569CD6
	function: "\x1b[38;2;220;220;170m", // #DCDCAA
	variable: "\x1b[38;2;156;220;254m", // #9CDCFE
	string: "\x1b[38;2;206;145;120m", // #CE9178
	number: "\x1b[38;2;181;206;168m", // #B5CEA8
	type: "\x1b[38;2;78;201;176m", // #4EC9B0
	operator: "\x1b[38;2;212;212;212m", // #D4D4D4
	punctuation: "\x1b[38;2;212;212;212m", // #D4D4D4
	control: "\x1b[38;2;197;134;192m", // #C586C0
	reset: "\x1b[39m",
};

const HIGHLIGHT_COLORS = {
	comment: COLORS.comment,
	keyword: COLORS.keyword,
	function: COLORS.function,
	variable: COLORS.variable,
	string: COLORS.string,
	number: COLORS.number,
	type: COLORS.type,
	operator: COLORS.operator,
	punctuation: COLORS.punctuation,
	control: COLORS.control,
	inserted: "",
	deleted: "",
};

/**
 * Helper to highlight code and check that a specific token appears with
 * the expected color.
 */
function expectTokenColor(code: string, lang: string, token: string, expectedColor: string) {
	const result = nativeHighlightCode(code, lang, HIGHLIGHT_COLORS);
	const colored = `${expectedColor}${token}${COLORS.reset}`;
	expect(result).toContain(colored);
}

/**
 * Helper to check that a token does NOT appear with a given color.
 */
function expectTokenNotColor(code: string, lang: string, token: string, unexpectedColor: string) {
	const result = nativeHighlightCode(code, lang, HIGHLIGHT_COLORS);
	const colored = `${unexpectedColor}${token}${COLORS.reset}`;
	expect(result).not.toContain(colored);
}

// ============================================================================
// Tier 1: Most critical languages
// ============================================================================

describe("Python syntax highlighting", () => {
	it("highlights comment text as green", () => {
		// Note: comment delimiter (#) is tokenized separately as punctuation
		expectTokenColor("# This is a comment", "python", " This is a comment", COLORS.comment);
	});

	it("highlights def as keyword", () => {
		expectTokenColor("def greet():\n    pass", "python", "def", COLORS.keyword);
	});

	it("highlights control flow (if/for/return) as control", () => {
		expectTokenColor("if x:\n    return y", "python", "if", COLORS.control);
		expectTokenColor("if x:\n    return y", "python", "return", COLORS.control);
		expectTokenColor("for i in x:\n    pass", "python", "for", COLORS.control);
	});

	it("highlights string literals as string", () => {
		expectTokenColor('x = "hello"', "python", "hello", COLORS.string);
	});

	it("highlights numbers as number", () => {
		expectTokenColor("x = 42", "python", "42", COLORS.number);
	});

	it("highlights True/False/None as keyword", () => {
		expectTokenColor("x = True", "python", "True", COLORS.keyword);
		expectTokenColor("x = False", "python", "False", COLORS.keyword);
		expectTokenColor("x = None", "python", "None", COLORS.keyword);
	});

	it("does NOT color True/False/None as number", () => {
		expectTokenNotColor("x = True", "python", "True", COLORS.number);
		expectTokenNotColor("x = None", "python", "None", COLORS.number);
	});

	it("highlights operators as operator (not keyword)", () => {
		expectTokenColor("x = 1 + 2", "python", "=", COLORS.operator);
		expectTokenColor("x = 1 + 2", "python", "+", COLORS.operator);
	});

	it("highlights function names as function", () => {
		expectTokenColor("def greet():\n    pass", "python", "greet", COLORS.function);
	});
});

describe("TypeScript/JavaScript syntax highlighting", () => {
	it("highlights const/let as keyword", () => {
		expectTokenColor("const x = 1;", "typescript", "const", COLORS.keyword);
	});

	it("highlights if/else/return as control", () => {
		expectTokenColor("if (x) { return y; }", "typescript", "if", COLORS.control);
		expectTokenColor("if (x) { return y; }", "typescript", "return", COLORS.control);
	});

	it("highlights string literals as string", () => {
		expectTokenColor('const s = "hello";', "typescript", "hello", COLORS.string);
	});

	it("highlights numbers as number", () => {
		expectTokenColor("const n = 3.14;", "typescript", "3.14", COLORS.number);
	});

	it("highlights operators as operator", () => {
		expectTokenColor("x === y", "typescript", "===", COLORS.operator);
	});

	it("highlights true/false/null as keyword", () => {
		expectTokenColor("const b = true;", "typescript", "true", COLORS.keyword);
		expectTokenColor("const n = null;", "typescript", "null", COLORS.keyword);
	});

	it("highlights comment text as comment", () => {
		// Note: comment delimiter (//) is tokenized separately as punctuation
		expectTokenColor("// a comment", "typescript", " a comment", COLORS.comment);
	});
});

describe("Bash/Shell syntax highlighting", () => {
	it("highlights comment text as comment", () => {
		expectTokenColor("# a comment", "bash", " a comment", COLORS.comment);
	});

	it("highlights control flow (if/then/fi/for/do/done) as control", () => {
		expectTokenColor("if [ -f x ]; then\necho y\nfi", "bash", "if", COLORS.control);
		expectTokenColor("if [ -f x ]; then\necho y\nfi", "bash", "then", COLORS.control);
	});

	it("highlights string literals as string", () => {
		expectTokenColor('echo "hello world"', "bash", "hello world", COLORS.string);
	});
});

describe("JSON syntax highlighting", () => {
	it("highlights string values as string", () => {
		expectTokenColor('{"key": "value"}', "json", "value", COLORS.string);
	});

	it("highlights numbers as number", () => {
		expectTokenColor('{"count": 42}', "json", "42", COLORS.number);
	});

	it("highlights true/false/null as keyword", () => {
		expectTokenColor('{"enabled": true}', "json", "true", COLORS.keyword);
		expectTokenColor('{"enabled": false}', "json", "false", COLORS.keyword);
		expectTokenColor('{"value": null}', "json", "null", COLORS.keyword);
	});

	it("does NOT color true/false/null as number", () => {
		expectTokenNotColor('{"enabled": true}', "json", "true", COLORS.number);
		expectTokenNotColor('{"value": null}', "json", "null", COLORS.number);
	});

	it("highlights string keys as string (JSON spec)", () => {
		// In JSON syntax, keys are string literals per the grammar
		expectTokenColor('{"key": "value"}', "json", "key", COLORS.string);
	});

	it("highlights punctuation as punctuation", () => {
		expectTokenColor('{"a": 1}', "json", "{", COLORS.punctuation);
		expectTokenColor('{"a": 1}', "json", "}", COLORS.punctuation);
	});
});

describe("Rust syntax highlighting", () => {
	it("highlights fn as keyword", () => {
		expectTokenColor("fn main() {}", "rust", "fn", COLORS.keyword);
	});

	it("highlights control flow (if/else/for/return) as control", () => {
		expectTokenColor("if x > 0 { return x; }", "rust", "if", COLORS.control);
		expectTokenColor("if x > 0 { return x; }", "rust", "return", COLORS.control);
	});

	it("highlights string literals as string", () => {
		expectTokenColor('let s = "hello";', "rust", "hello", COLORS.string);
	});

	it("highlights numbers as number", () => {
		expectTokenColor("let n = 42;", "rust", "42", COLORS.number);
	});

	it("highlights true/false as keyword", () => {
		expectTokenColor("let b = true;", "rust", "true", COLORS.keyword);
	});

	it("highlights operators as operator (not keyword)", () => {
		expectTokenColor("let x = 1 + 2;", "rust", "+", COLORS.operator);
		expectTokenColor("let x = 1 + 2;", "rust", "=", COLORS.operator);
	});

	it("highlights comment text as comment", () => {
		expectTokenColor("// a comment", "rust", " a comment", COLORS.comment);
	});
});

// ============================================================================
// Tier 2: Common languages
// ============================================================================

describe("Go syntax highlighting", () => {
	it("highlights func as keyword", () => {
		expectTokenColor("func main() {}", "go", "func", COLORS.keyword);
	});

	it("highlights if/for/return as control", () => {
		expectTokenColor("if x > 0 {\n    return x\n}", "go", "if", COLORS.control);
		expectTokenColor("if x > 0 {\n    return x\n}", "go", "return", COLORS.control);
	});

	it("highlights string literals as string", () => {
		expectTokenColor('s := "hello"', "go", "hello", COLORS.string);
	});

	it("highlights numbers as number", () => {
		expectTokenColor("n := 42", "go", "42", COLORS.number);
	});

	it("highlights true/false/nil as keyword", () => {
		expectTokenColor("b := true", "go", "true", COLORS.keyword);
		expectTokenColor("p = nil", "go", "nil", COLORS.keyword);
	});
});

describe("YAML syntax highlighting", () => {
	it("highlights string values as string", () => {
		expectTokenColor('name: "hello"', "yaml", "hello", COLORS.string);
	});

	it("highlights true/false as keyword", () => {
		expectTokenColor("enabled: true", "yaml", "true", COLORS.keyword);
	});

	it("highlights numbers as number", () => {
		expectTokenColor("count: 42", "yaml", "42", COLORS.number);
	});
});

describe("SQL syntax highlighting", () => {
	it("highlights SELECT/FROM/WHERE as keyword", () => {
		expectTokenColor("SELECT name FROM users WHERE id = 1", "sql", "SELECT", COLORS.keyword);
		expectTokenColor("SELECT name FROM users WHERE id = 1", "sql", "FROM", COLORS.keyword);
		expectTokenColor("SELECT name FROM users WHERE id = 1", "sql", "WHERE", COLORS.keyword);
	});

	it("highlights string literals as string", () => {
		expectTokenColor("WHERE name = 'alice'", "sql", "alice", COLORS.string);
	});

	it("highlights numbers as number", () => {
		expectTokenColor("WHERE id = 42", "sql", "42", COLORS.number);
	});
});

describe("HTML syntax highlighting", () => {
	it("highlights tag names as keyword (not variable)", () => {
		expectTokenColor("<div>content</div>", "html", "div", COLORS.keyword);
	});

	it("does NOT color tag names as variable", () => {
		expectTokenNotColor("<div>content</div>", "html", "div", COLORS.variable);
	});

	it("highlights attribute values as string", () => {
		expectTokenColor('<div class="main">', "html", "main", COLORS.string);
	});
});

describe("Diff syntax highlighting", () => {
	const DIFF = `--- a/file.txt
+++ b/file.txt
@@ -1,3 +1,3 @@
 context line
-removed line
+added line`;

	it("highlights removed lines with deleted color", () => {
		// Diff test uses inserted/deleted which are empty in our test config
		// This test verifies the diff scopes are properly classified
		const result = nativeHighlightCode(DIFF, "diff", {
			...HIGHLIGHT_COLORS,
			inserted: "\x1b[32m",
			deleted: "\x1b[31m",
		});
		expect(result).toContain("\x1b[31m");
		expect(result).toContain("\x1b[32m");
	});
});

// ============================================================================
// Tier 3: Less common but still important languages
// ============================================================================

describe("C syntax highlighting", () => {
	it("highlights keywords", () => {
		expectTokenColor("int main(void) { return 0; }", "c", "int", COLORS.keyword);
	});

	it("highlights control flow as control", () => {
		expectTokenColor("if (x > 0) { return x; }", "c", "if", COLORS.control);
		expectTokenColor("if (x > 0) { return x; }", "c", "return", COLORS.control);
	});

	it("highlights string literals", () => {
		expectTokenColor('char *s = "hello";', "c", "hello", COLORS.string);
	});

	it("highlights numbers", () => {
		expectTokenColor("int x = 42;", "c", "42", COLORS.number);
	});

	it("highlights operators as operator", () => {
		expectTokenColor("x = a + b;", "c", "+", COLORS.operator);
	});
});

describe("C++ syntax highlighting", () => {
	it("highlights keywords", () => {
		expectTokenColor("class Foo {};", "cpp", "class", COLORS.keyword);
	});

	it("highlights control flow as control", () => {
		expectTokenColor("for (int i = 0; i < n; i++) {}", "cpp", "for", COLORS.control);
	});

	it("highlights string literals", () => {
		expectTokenColor('std::string s = "hello";', "cpp", "hello", COLORS.string);
	});

	it("highlights numbers", () => {
		expectTokenColor("int x = 100;", "cpp", "100", COLORS.number);
	});

	it("highlights true/false as keyword", () => {
		expectTokenColor("bool b = true;", "cpp", "true", COLORS.keyword);
	});
});

describe("Java syntax highlighting", () => {
	it("highlights keywords", () => {
		expectTokenColor("public class Foo {}", "java", "public", COLORS.keyword);
		expectTokenColor("public class Foo {}", "java", "class", COLORS.keyword);
	});

	it("highlights control flow as control", () => {
		expectTokenColor("if (x > 0) { return x; }", "java", "if", COLORS.control);
		expectTokenColor("if (x > 0) { return x; }", "java", "return", COLORS.control);
	});

	it("highlights string literals", () => {
		expectTokenColor('String s = "hello";', "java", "hello", COLORS.string);
	});

	it("highlights numbers", () => {
		expectTokenColor("int x = 42;", "java", "42", COLORS.number);
	});

	it("highlights true/false/null as keyword", () => {
		expectTokenColor("boolean b = true;", "java", "true", COLORS.keyword);
		expectTokenColor("Object o = null;", "java", "null", COLORS.keyword);
	});
});

describe("Ruby syntax highlighting", () => {
	it("highlights def as control (keyword.control.def.ruby)", () => {
		// Ruby's `def` has scope keyword.control, so it maps to control color
		expectTokenColor("def greet\nend", "ruby", "def", COLORS.control);
	});

	it("highlights control flow as control", () => {
		expectTokenColor("if x > 0\n  return x\nend", "ruby", "if", COLORS.control);
		expectTokenColor("if x > 0\n  return x\nend", "ruby", "return", COLORS.control);
	});

	it("highlights string literals", () => {
		expectTokenColor('s = "hello"', "ruby", "hello", COLORS.string);
	});

	it("highlights numbers", () => {
		expectTokenColor("x = 42", "ruby", "42", COLORS.number);
	});

	it("highlights true/false/nil as keyword", () => {
		expectTokenColor("b = true", "ruby", "true", COLORS.keyword);
		expectTokenColor("x = nil", "ruby", "nil", COLORS.keyword);
	});
});

describe("PHP syntax highlighting", () => {
	it("highlights keywords", () => {
		expectTokenColor("<?php\nfunction greet() {}", "php", "function", COLORS.keyword);
	});

	it("highlights control flow as control", () => {
		expectTokenColor("<?php\nif ($x > 0) { return $x; }", "php", "if", COLORS.control);
		expectTokenColor("<?php\nif ($x > 0) { return $x; }", "php", "return", COLORS.control);
	});

	it("highlights string literals", () => {
		expectTokenColor("<?php\n$s = 'hello';", "php", "hello", COLORS.string);
	});

	it("highlights numbers", () => {
		expectTokenColor("<?php\n$x = 42;", "php", "42", COLORS.number);
	});

	it("highlights true/false/null as keyword", () => {
		expectTokenColor("<?php\n$b = true;", "php", "true", COLORS.keyword);
		expectTokenColor("<?php\n$n = null;", "php", "null", COLORS.keyword);
	});
});

describe("CSS syntax highlighting", () => {
	it("highlights property values as number", () => {
		expectTokenColor("div { width: 100px; }", "css", "100", COLORS.number);
	});

	it("highlights string values", () => {
		expectTokenColor('div { font-family: "Arial"; }', "css", "Arial", COLORS.string);
	});

	it("highlights punctuation", () => {
		expectTokenColor("div { color: red; }", "css", "{", COLORS.punctuation);
		expectTokenColor("div { color: red; }", "css", "}", COLORS.punctuation);
	});
});

// Dockerfile, TOML, and Terraform aliases are registered but syntect's default
// syntax set doesn't include their grammars. These tests verify graceful fallback
// (returns original text, no crash) rather than specific color assertions.

describe("Dockerfile syntax highlighting (graceful fallback)", () => {
	it("returns text without crashing", () => {
		const result = nativeHighlightCode("FROM ubuntu:22.04\nRUN apt-get update", "dockerfile", HIGHLIGHT_COLORS);
		expect(result).toContain("FROM");
		expect(result).toContain("ubuntu");
	});
});

describe("TOML syntax highlighting (graceful fallback)", () => {
	it("returns text without crashing", () => {
		const result = nativeHighlightCode('name = "hello"\nport = 8080', "toml", HIGHLIGHT_COLORS);
		expect(result).toContain("name");
		expect(result).toContain("hello");
	});
});

describe("Makefile syntax highlighting", () => {
	it("returns text without crashing", () => {
		const result = nativeHighlightCode("all: build\n\nbuild:\n\techo done", "makefile", HIGHLIGHT_COLORS);
		expect(result).toBeTruthy();
		expect(result.length).toBeGreaterThan(0);
	});
});

describe("Terraform/HCL syntax highlighting (graceful fallback)", () => {
	it("returns text without crashing", () => {
		const result = nativeHighlightCode('resource "aws_instance" "web" {}', "terraform", HIGHLIGHT_COLORS);
		expect(result).toContain("resource");
		expect(result).toContain("aws_instance");
	});
});

// ============================================================================
// Cross-cutting: control flow keyword regression test
// ============================================================================

describe("Control flow keywords across languages", () => {
	const controlCases = [
		{ lang: "python", code: "if x:\n    pass", token: "if" },
		{ lang: "python", code: "for i in x:\n    pass", token: "for" },
		{ lang: "python", code: "while True:\n    pass", token: "while" },
		{ lang: "python", code: "if x:\n    return y", token: "return" },
		{ lang: "python", code: "import os", token: "import" },
		{ lang: "typescript", code: "if (x) {}", token: "if" },
		{ lang: "typescript", code: "for (;;) {}", token: "for" },
		{ lang: "typescript", code: "while (true) {}", token: "while" },
		{ lang: "typescript", code: "if (x) { return y; }", token: "return" },
		{ lang: "typescript", code: 'import x from "y";', token: "import" },
		{ lang: "rust", code: "if x > 0 {}", token: "if" },
		{ lang: "rust", code: "for i in 0..10 {}", token: "for" },
		{ lang: "rust", code: "loop {}", token: "loop" },
		{ lang: "rust", code: "if x > 0 { return x; }", token: "return" },
		{ lang: "go", code: "if x > 0 {}", token: "if" },
		{ lang: "go", code: "for i := 0; i < 10; i++ {}", token: "for" },
		{ lang: "go", code: "if x > 0 {\n    return x\n}", token: "return" },
		{ lang: "c", code: "if (x > 0) {}", token: "if" },
		{ lang: "c", code: "for (;;) {}", token: "for" },
		{ lang: "c", code: "while (1) {}", token: "while" },
		{ lang: "c", code: "if (x) { return x; }", token: "return" },
		{ lang: "java", code: "if (x > 0) {}", token: "if" },
		{ lang: "java", code: "for (;;) {}", token: "for" },
		{ lang: "java", code: "if (x > 0) { return x; }", token: "return" },
	];

	for (const { lang, code, token } of controlCases) {
		it(`${lang}: '${token}' should be control color (purple), not keyword`, () => {
			expectTokenColor(code, lang, token, COLORS.control);
		});
	}
});

// ============================================================================
// Cross-cutting: operator vs keyword regression test
// ============================================================================

describe("Operator vs keyword distinction (cross-language regression)", () => {
	const languages = [
		{ lang: "python", code: "x = 1 + 2", ops: ["=", "+"] },
		{ lang: "typescript", code: "x === y && z", ops: ["===", "&&"] },
		{ lang: "rust", code: "let x = a + b;", ops: ["=", "+"] },
		{ lang: "go", code: "x := a + b", ops: ["+"] },
	];

	for (const { lang, code, ops } of languages) {
		for (const op of ops) {
			it(`${lang}: '${op}' should be operator color, not keyword`, () => {
				expectTokenColor(code, lang, op, COLORS.operator);
				expectTokenNotColor(code, lang, op, COLORS.keyword);
			});
		}
	}
});

// ============================================================================
// Cross-cutting: constant.language regression test
// ============================================================================

describe("Language constants (true/false/null/None) regression", () => {
	const cases = [
		{ lang: "python", code: "x = True", token: "True" },
		{ lang: "python", code: "x = False", token: "False" },
		{ lang: "python", code: "x = None", token: "None" },
		{ lang: "typescript", code: "const b = true;", token: "true" },
		{ lang: "typescript", code: "const b = false;", token: "false" },
		{ lang: "typescript", code: "const n = null;", token: "null" },
		{ lang: "json", code: '{"a": true}', token: "true" },
		{ lang: "json", code: '{"a": false}', token: "false" },
		{ lang: "json", code: '{"a": null}', token: "null" },
		{ lang: "rust", code: "let b = true;", token: "true" },
		{ lang: "go", code: "b := true", token: "true" },
		{ lang: "go", code: "p = nil", token: "nil" },
	];

	for (const { lang, code, token } of cases) {
		it(`${lang}: '${token}' should be keyword color, NOT number`, () => {
			expectTokenColor(code, lang, token, COLORS.keyword);
			expectTokenNotColor(code, lang, token, COLORS.number);
		});
	}
});
