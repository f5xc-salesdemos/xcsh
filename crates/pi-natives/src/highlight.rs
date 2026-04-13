//! Syntax highlighting using syntect.
//!
//! Provides ANSI-colored output for code blocks. Takes theme colors as input
//! and maps syntect scopes to 11 semantic categories:
//! - comment, keyword, function, variable, string, number, type, operator,
//!   punctuation, inserted, deleted

use std::{cell::RefCell, collections::HashMap, sync::OnceLock};

use napi_derive::napi;
use syntect::parsing::{ParseState, Scope, ScopeStack, ScopeStackOp, SyntaxReference, SyntaxSet};

static SYNTAX_SET: OnceLock<SyntaxSet> = OnceLock::new();
static SCOPE_MATCHERS: OnceLock<ScopeMatchers> = OnceLock::new();

// Thread-local cache for scope -> color index lookups
thread_local! {
	static SCOPE_COLOR_CACHE: RefCell<HashMap<Scope, usize>> = RefCell::new(HashMap::with_capacity(256));
}

fn get_syntax_set() -> &'static SyntaxSet {
	SYNTAX_SET.get_or_init(SyntaxSet::load_defaults_newlines)
}

/// Pre-compiled scope patterns for fast matching.
struct ScopeMatchers {
	// Comment (index 0)
	comment: Scope,

	// String (index 4)
	string:                    Scope,
	constant_character:        Scope,
	constant_character_escape: Scope,
	meta_string:               Scope,

	// Number (index 5)
	constant_numeric: Scope,
	constant_integer: Scope,
	constant:         Scope,

	// Keyword (index 1)
	keyword:           Scope,
	constant_language: Scope,
	variable_language: Scope,
	entity_name_tag:   Scope,
	storage_type:      Scope,
	storage_modifier:  Scope,

	// Control flow keyword (index 11)
	keyword_control: Scope,

	// Function (index 2)
	entity_name_function: Scope,
	support_function:     Scope,
	meta_function_call:   Scope,
	variable_function:    Scope,

	// Type (index 6)
	entity_name_type:      Scope,
	support_type:          Scope,
	support_class:         Scope,
	entity_name_class:     Scope,
	entity_name_struct:    Scope,
	entity_name_enum:      Scope,
	entity_name_interface: Scope,
	entity_name_trait:     Scope,

	// Operator (index 7)
	keyword_operator:     Scope,
	punctuation_accessor: Scope,

	// Punctuation (index 8)
	punctuation: Scope,

	// Variable (index 3)
	variable:    Scope,
	entity_name: Scope,
	meta_path:   Scope,

	// Diff (indices 9, 10)
	markup_inserted:  Scope,
	markup_deleted:   Scope,
	meta_diff_header: Scope,
	meta_diff_range:  Scope,

	// Property/attribute names → variable (index 3)
	entity_other_attribute_name: Scope, /* HTML/XML/Astro attribute names
	                                     * (entity.other.attribute-name.*) */
	meta_structure_dict_key:     Scope, /* JSON / YAML dictionary keys
	                                     * (meta.structure.dictionary.key.*) */

	// YAML mapping keys → variable (index 3); must precede generic entity.name.tag → keyword
	entity_name_tag_yaml: Scope,

	// CSS / SCSS property names → variable (index 3); must precede generic support.type → type
	support_type_property_name: Scope,

	// Markdown section headings → keyword (index 1); must precede generic entity.name → variable
	entity_name_section: Scope,

	// Markdown rich text → appropriate semantic colors
	markup_bold:   Scope, // bold text  → keyword (index 1)
	markup_italic: Scope, // italic text → keyword (index 1)
	markup_quote:  Scope, // blockquotes → comment (index 0)
	markup_raw:    Scope, // inline code → string  (index 4)

	// Ruby / Elixir / Crystal symbols → string (index 4); must precede generic constant → number
	constant_other_symbol: Scope,

	// Comment-defining punctuation (shebangs, //, /* */ markers) → comment (index 0)
	// Must precede generic punctuation → punctuation
	punctuation_definition_comment: Scope,
}

impl ScopeMatchers {
	fn new() -> Self {
		Self {
			comment: Scope::new("comment").unwrap(),
			string: Scope::new("string").unwrap(),
			constant_character: Scope::new("constant.character").unwrap(),
			constant_character_escape: Scope::new("constant.character.escape").unwrap(),
			meta_string: Scope::new("meta.string").unwrap(),
			constant_numeric: Scope::new("constant.numeric").unwrap(),
			constant_integer: Scope::new("constant.integer").unwrap(),
			constant: Scope::new("constant").unwrap(),
			keyword: Scope::new("keyword").unwrap(),
			constant_language: Scope::new("constant.language").unwrap(),
			variable_language: Scope::new("variable.language").unwrap(),
			entity_name_tag: Scope::new("entity.name.tag").unwrap(),
			storage_type: Scope::new("storage.type").unwrap(),
			storage_modifier: Scope::new("storage.modifier").unwrap(),
			keyword_control: Scope::new("keyword.control").unwrap(),
			entity_name_function: Scope::new("entity.name.function").unwrap(),
			support_function: Scope::new("support.function").unwrap(),
			meta_function_call: Scope::new("meta.function-call").unwrap(),
			variable_function: Scope::new("variable.function").unwrap(),
			entity_name_type: Scope::new("entity.name.type").unwrap(),
			support_type: Scope::new("support.type").unwrap(),
			support_class: Scope::new("support.class").unwrap(),
			entity_name_class: Scope::new("entity.name.class").unwrap(),
			entity_name_struct: Scope::new("entity.name.struct").unwrap(),
			entity_name_enum: Scope::new("entity.name.enum").unwrap(),
			entity_name_interface: Scope::new("entity.name.interface").unwrap(),
			entity_name_trait: Scope::new("entity.name.trait").unwrap(),
			keyword_operator: Scope::new("keyword.operator").unwrap(),
			punctuation_accessor: Scope::new("punctuation.accessor").unwrap(),
			punctuation: Scope::new("punctuation").unwrap(),
			variable: Scope::new("variable").unwrap(),
			entity_name: Scope::new("entity.name").unwrap(),
			meta_path: Scope::new("meta.path").unwrap(),
			markup_inserted: Scope::new("markup.inserted").unwrap(),
			markup_deleted: Scope::new("markup.deleted").unwrap(),
			meta_diff_header: Scope::new("meta.diff.header").unwrap(),
			meta_diff_range: Scope::new("meta.diff.range").unwrap(),
			entity_other_attribute_name: Scope::new("entity.other.attribute-name").unwrap(),
			meta_structure_dict_key: Scope::new("meta.structure.dictionary.key").unwrap(),
			entity_name_tag_yaml: Scope::new("entity.name.tag.yaml").unwrap(),
			support_type_property_name: Scope::new("support.type.property-name").unwrap(),
			entity_name_section: Scope::new("entity.name.section").unwrap(),
			markup_bold: Scope::new("markup.bold").unwrap(),
			markup_italic: Scope::new("markup.italic").unwrap(),
			markup_quote: Scope::new("markup.quote").unwrap(),
			markup_raw: Scope::new("markup.raw").unwrap(),
			constant_other_symbol: Scope::new("constant.other.symbol").unwrap(),
			punctuation_definition_comment: Scope::new("punctuation.definition.comment").unwrap(),
		}
	}
}

fn get_scope_matchers() -> &'static ScopeMatchers {
	SCOPE_MATCHERS.get_or_init(ScopeMatchers::new)
}

/// Theme colors for syntax highlighting.
/// Each color is an ANSI escape sequence (e.g., "\x1b[38;2;255;0;0m").
#[derive(Debug)]
#[napi(object)]
pub struct HighlightColors {
	/// ANSI color for comments.
	pub comment:     String,
	/// ANSI color for keywords.
	pub keyword:     String,
	/// ANSI color for function names.
	pub function:    String,
	/// ANSI color for variables and identifiers.
	pub variable:    String,
	/// ANSI color for string literals.
	pub string:      String,
	/// ANSI color for numeric literals.
	pub number:      String,
	/// ANSI color for type identifiers.
	pub r#type:      String,
	/// ANSI color for operators.
	pub operator:    String,
	/// ANSI color for punctuation tokens.
	pub punctuation: String,
	/// ANSI color for control flow keywords (if, else, for, while, return,
	/// import).
	pub control:     Option<String>,
	/// ANSI color for diff inserted lines.
	pub inserted:    Option<String>,
	/// ANSI color for diff deleted lines.
	pub deleted:     Option<String>,
}

/// Language alias mappings: (aliases, target syntax name).
/// Used for languages not in syntect's default set or with non-standard names.
const LANG_ALIASES: &[(&[&str], &str)] = &[
	(&["ts", "tsx", "typescript", "js", "jsx", "javascript", "mjs", "cjs"], "JavaScript"),
	(&["py", "python"], "Python"),
	(&["rb", "ruby"], "Ruby"),
	(&["rs", "rust"], "Rust"),
	(&["go", "golang"], "Go"),
	(&["java"], "Java"),
	(&["kt", "kotlin"], "Java"),
	(&["swift"], "Objective-C"),
	(&["c", "h"], "C"),
	(&["cpp", "cc", "cxx", "c++", "hpp", "hxx", "hh"], "C++"),
	(&["cs", "csharp"], "C#"),
	(&["php"], "PHP"),
	(&["sh", "bash", "zsh", "shell"], "Bash"),
	(&["ps1", "powershell"], "PowerShell"),
	(&["html", "htm", "astro", "vue", "svelte"], "HTML"),
	(&["css"], "CSS"),
	(&["scss"], "SCSS"),
	(&["sass"], "Sass"),
	(&["less"], "LESS"),
	(&["json"], "JSON"),
	(&["yaml", "yml"], "YAML"),
	(&["toml"], "TOML"),
	(&["xml"], "XML"),
	(&["md", "markdown"], "Markdown"),
	(&["sql"], "SQL"),
	(&["lua"], "Lua"),
	(&["perl", "pl", "pm"], "Perl"),
	(&["r"], "R"),
	(&["scala"], "Scala"),
	(&["clj", "clojure"], "Clojure"),
	(&["ex", "exs", "elixir"], "Ruby"),
	(&["erl", "erlang"], "Erlang"),
	(&["hs", "haskell"], "Haskell"),
	(&["ml", "ocaml"], "OCaml"),
	(&["vim"], "VimL"),
	(&["graphql", "gql"], "GraphQL"),
	(&["proto", "protobuf"], "Protocol Buffers"),
	(&["tf", "hcl", "terraform"], "Terraform"),
	(&["dockerfile", "docker", "containerfile"], "Dockerfile"),
	(&["makefile", "make", "just", "justfile"], "Makefile"),
	(&["cmake", "cmakelists"], "CMake"),
	(&["ini", "cfg", "conf", "config", "properties"], "INI"),
	(&["diff", "patch"], "Diff"),
	(&["gitignore", "gitattributes", "gitmodules"], "Git Ignore"),
];

/// Find syntax name from alias table using case-insensitive comparison.
#[inline]
fn find_alias(lang: &str) -> Option<&'static str> {
	LANG_ALIASES
		.iter()
		.find(|(aliases, _)| aliases.iter().any(|a| lang.eq_ignore_ascii_case(a)))
		.map(|(_, target)| *target)
}

/// Check if language is in the alias table.
#[inline]
fn is_known_alias(lang: &str) -> bool {
	LANG_ALIASES
		.iter()
		.any(|(aliases, _)| aliases.iter().any(|a| lang.eq_ignore_ascii_case(a)))
}

/// Compute the color index for a single scope (uncached).
///
/// Ordering is critical: more-specific scopes must be checked before their
/// generic prefixes.  For example `keyword.operator` (operator, index 7) must
/// come before the blanket `keyword` check (keyword, index 1), otherwise
/// operators would be colored as keywords.
#[inline]
fn compute_scope_color(s: Scope) -> usize {
	let m = get_scope_matchers();

	// ── Comment (index 0) ──────────────────────────────────────────────
	if m.comment.is_prefix_of(s) {
		return 0;
	}

	// ── Diff (indices 9, 10, 1) ────────────────────────────────────────
	if m.markup_inserted.is_prefix_of(s) {
		return 9;
	}
	if m.markup_deleted.is_prefix_of(s) {
		return 10;
	}
	if m.meta_diff_header.is_prefix_of(s) || m.meta_diff_range.is_prefix_of(s) {
		return 1;
	}

	// ── Markdown rich text ─────────────────────────────────────────────
	// Bold and italic → keyword (index 1, blue)
	if m.markup_bold.is_prefix_of(s) || m.markup_italic.is_prefix_of(s) {
		return 1;
	}
	// Blockquotes → comment (index 0, dim green)
	if m.markup_quote.is_prefix_of(s) {
		return 0;
	}
	// Inline code spans → string (index 4, orange)
	if m.markup_raw.is_prefix_of(s) {
		return 4;
	}

	// ── String (index 4) ───────────────────────────────────────────────
	// constant.character.escape (e.g. \n inside strings) -> string
	if m.constant_character_escape.is_prefix_of(s) {
		return 4;
	}
	if m.string.is_prefix_of(s) || m.meta_string.is_prefix_of(s) {
		return 4;
	}

	// ── Language constants -> keyword (index 1) ────────────────────────
	// true, false, None, nil, null  (scope: constant.language)
	if m.constant_language.is_prefix_of(s) {
		return 1;
	}

	// ── Number (index 5) ───────────────────────────────────────────────
	if m.constant_numeric.is_prefix_of(s) || m.constant_integer.is_prefix_of(s) {
		return 5;
	}

	// ── Operator (index 7) — MUST come before generic keyword ──────────
	// keyword.operator.* would otherwise be swallowed by keyword prefix
	if m.keyword_operator.is_prefix_of(s) || m.punctuation_accessor.is_prefix_of(s) {
		return 7;
	}

	// ── Control flow keyword (index 11) — if, else, for, while, return ─
	// keyword.control.* must come before generic keyword check
	if m.keyword_control.is_prefix_of(s) {
		return 11;
	}

	// ── Keyword (index 1) ──────────────────────────────────────────────
	if m.keyword.is_prefix_of(s)
		|| m.storage_type.is_prefix_of(s)
		|| m.storage_modifier.is_prefix_of(s)
	{
		return 1;
	}

	// ── Function (index 2) ─────────────────────────────────────────────
	if m.entity_name_function.is_prefix_of(s)
		|| m.support_function.is_prefix_of(s)
		|| m.meta_function_call.is_prefix_of(s)
		|| m.variable_function.is_prefix_of(s)
	{
		return 2;
	}

	// ── CSS/SCSS property names → variable (index 3) ──────────────────
	// support.type.property-name.css must come before the generic support.type
	// check; CSS properties are light-blue (variable) in VS Code Dark+, not teal.
	if m.support_type_property_name.is_prefix_of(s) {
		return 3;
	}

	// ── Type (index 6) ─────────────────────────────────────────────────
	if m.entity_name_type.is_prefix_of(s)
		|| m.support_type.is_prefix_of(s)
		|| m.support_class.is_prefix_of(s)
		|| m.entity_name_class.is_prefix_of(s)
		|| m.entity_name_struct.is_prefix_of(s)
		|| m.entity_name_enum.is_prefix_of(s)
		|| m.entity_name_interface.is_prefix_of(s)
		|| m.entity_name_trait.is_prefix_of(s)
	{
		return 6;
	}

	// ── HTML/XML/Astro attribute names → variable (index 3) ──────────────
	// entity.other.attribute-name.* does NOT start with entity.name, so it
	// would otherwise fall through to usize::MAX (no color).  Must come
	// before the entity_name_tag check since both live in the HTML/XML family.
	if m.entity_other_attribute_name.is_prefix_of(s) {
		return 3;
	}

	// ── YAML mapping keys → variable (index 3) ────────────────────────
	// entity.name.tag.yaml is used for YAML keys.  VS Code Dark+ colors
	// them as variable (light-blue), not as keyword-blue like HTML tags.
	// Must come before the generic entity.name.tag → keyword check.
	if m.entity_name_tag_yaml.is_prefix_of(s) {
		return 3;
	}

	// ── HTML/XML tags -> keyword (index 1) ─────────────────────────────
	// entity.name.tag must come before the generic entity.name -> variable
	if m.entity_name_tag.is_prefix_of(s) {
		return 1;
	}

	// ── Markdown section headings → keyword (index 1) ──────────────────
	// entity.name.section.markdown must come before the generic entity.name
	// → variable check.  VS Code Dark+ colors headings as keyword-blue.
	if m.entity_name_section.is_prefix_of(s) {
		return 1;
	}

	// ── Punctuation (index 8) ──────────────────────────────────────────
	// Comment-defining punctuation (shebang #!, //, /* — scope:
	// punctuation.definition.comment.*) should render as comment (dim
	// green) rather than as plain punctuation (gray).
	if m.punctuation_definition_comment.is_prefix_of(s) {
		return 0;
	}
	if m.punctuation.is_prefix_of(s) {
		return 8;
	}

	// ── Language variables -> keyword (index 1) ────────────────────────
	// this, self, super  (scope: variable.language)
	if m.variable_language.is_prefix_of(s) {
		return 1;
	}

	// ── Variable (index 3) ─────────────────────────────────────────────
	if m.variable.is_prefix_of(s) || m.entity_name.is_prefix_of(s) || m.meta_path.is_prefix_of(s) {
		return 3;
	}

	// ── Character constants -> keyword (index 1) ───────────────────────
	// bare constant.character (e.g. 'a' in C/Rust), not escape sequences
	if m.constant_character.is_prefix_of(s) {
		return 1;
	}

	// ── Ruby / Elixir / Crystal symbols → string (index 4) ─────────────
	// constant.other.symbol.ruby/:elixir collides with the generic constant
	// fallback (→ number/green).  VS Code Dark+ treats symbols as strings
	// (orange), so check this before the generic constant catch-all.
	if m.constant_other_symbol.is_prefix_of(s) {
		return 4;
	}

	// ── Generic constant -> number (index 5) ───────────────────────────
	if m.constant.is_prefix_of(s) {
		return 5;
	}

	// No match
	usize::MAX
}

/// Determine the semantic color category from a scope stack.
/// Uses per-scope caching to avoid repeated prefix checks.
///
/// Stack-level checks run first for cases where the innermost scope alone is
/// ambiguous.  For example, a JSON object key has scope stack
/// `[…, meta.structure.dictionary.key.json, string.quoted.double.json]`; the
/// per-scope loop would see `string` first and color the key like a value.
/// Checking the full stack beforehand lets us distinguish the two.
#[inline]
fn scope_to_color_index(scope: &ScopeStack) -> usize {
	let m = get_scope_matchers();
	let scopes = scope.as_slice();

	// ── Stack-level context checks ────────────────────────────────────────
	// JSON / YAML dictionary keys → variable (light blue, index 3).
	// The key context (meta.structure.dictionary.key.*) sits outside the
	// string scope in the stack, so it must be checked here, not in the
	// per-scope loop where string wins first.
	if scopes
		.iter()
		.any(|s| m.meta_structure_dict_key.is_prefix_of(*s))
	{
		return 3;
	}

	// Diff: color every token on a deleted / inserted line with the
	// appropriate diff color, including the -/+ prefix marker which
	// otherwise falls into the generic punctuation bucket (gray).
	if scopes.iter().any(|s| m.markup_deleted.is_prefix_of(*s)) {
		return 10;
	}
	if scopes.iter().any(|s| m.markup_inserted.is_prefix_of(*s)) {
		return 9;
	}
	// Diff header (--- a/file, +++ b/file) and range (@@ ... @@) lines:
	// the ---, +++, and @@ tokens are punctuation in the stack context of
	// meta.diff.header / meta.diff.range, so they need a stack-level
	// override to get keyword-blue instead of gray punctuation.
	if scopes
		.iter()
		.any(|s| m.meta_diff_header.is_prefix_of(*s) || m.meta_diff_range.is_prefix_of(*s))
	{
		return 1;
	}

	SCOPE_COLOR_CACHE.with(|cache| {
		let mut cache = cache.borrow_mut();

		// Walk from innermost to outermost scope
		for s in scopes.iter().rev() {
			let color_idx = *cache.entry(*s).or_insert_with(|| compute_scope_color(*s));
			if color_idx != usize::MAX {
				return color_idx;
			}
		}

		usize::MAX
	})
}

/// Find the appropriate syntax for a language name.
fn find_syntax<'a>(ss: &'a SyntaxSet, lang: &str) -> Option<&'a SyntaxReference> {
	// Direct name/token match (syntect APIs are case-insensitive)
	if let Some(syn) = ss.find_syntax_by_token(lang) {
		return Some(syn);
	}

	// Extension-based match
	if let Some(syn) = ss.find_syntax_by_extension(lang) {
		return Some(syn);
	}

	// Alias lookup for languages not in syntect's default set
	let alias = find_alias(lang)?;

	ss.find_syntax_by_name(alias)
		.or_else(|| ss.find_syntax_by_token(alias))
}

/// Highlight code and return ANSI-colored lines.
///
/// # Arguments
/// * `code` - The source code to highlight
/// * `lang` - Language identifier (e.g., "rust", "typescript", "python")
/// * `colors` - Theme colors as ANSI escape sequences
///
/// # Returns
/// Highlighted code with ANSI color codes, or the original code if highlighting
/// fails.
#[napi]
pub fn highlight_code(code: String, lang: Option<String>, colors: HighlightColors) -> String {
	let inserted = colors.inserted.as_deref().unwrap_or("");
	let deleted = colors.deleted.as_deref().unwrap_or("");
	let control = colors.control.as_deref().unwrap_or(colors.keyword.as_str());

	// Color palette as array for quick indexing
	let palette = [
		colors.comment.as_str(),     // 0
		colors.keyword.as_str(),     // 1
		colors.function.as_str(),    // 2
		colors.variable.as_str(),    // 3
		colors.string.as_str(),      // 4
		colors.number.as_str(),      // 5
		colors.r#type.as_str(),      // 6
		colors.operator.as_str(),    // 7
		colors.punctuation.as_str(), // 8
		inserted,                    // 9
		deleted,                     // 10
		control,                     // 11
	];

	let ss = get_syntax_set();

	// Find syntax for the language
	let syntax = match &lang {
		Some(l) => find_syntax(ss, l),
		None => None,
	}
	.unwrap_or_else(|| ss.find_syntax_plain_text());

	let mut parse_state = ParseState::new(syntax);
	let mut scope_stack = ScopeStack::new();
	let mut result = String::with_capacity(code.len() * 2);

	for line in syntect::util::LinesWithEndings::from(code.as_str()) {
		let Ok(ops) = parse_state.parse_line(line, ss) else {
			// Parse error - append unhighlighted line and continue
			result.push_str(line);
			continue;
		};

		let mut prev_end = 0;
		for (offset, op) in ops {
			let offset = offset.min(line.len());

			// Output text BEFORE this operation using current scope
			if offset > prev_end {
				let text = &line[prev_end..offset];
				let color_idx = scope_to_color_index(&scope_stack);

				if color_idx < palette.len() && !palette[color_idx].is_empty() {
					result.push_str(palette[color_idx]);
					result.push_str(text);
					result.push_str("\x1b[39m");
				} else {
					result.push_str(text);
				}
			}
			prev_end = offset;

			// Now apply scope operation for NEXT segment
			match op {
				ScopeStackOp::Push(scope) => {
					scope_stack.push(scope);
				},
				ScopeStackOp::Pop(count) => {
					for _ in 0..count {
						scope_stack.pop();
					}
				},
				ScopeStackOp::Restore | ScopeStackOp::Clear(_) | ScopeStackOp::Noop => {},
			}
		}

		// Output remaining text with current scope
		if prev_end < line.len() {
			let text = &line[prev_end..];
			let color_idx = scope_to_color_index(&scope_stack);

			if color_idx < palette.len() && !palette[color_idx].is_empty() {
				result.push_str(palette[color_idx]);
				result.push_str(text);
				result.push_str("\x1b[39m");
			} else {
				result.push_str(text);
			}
		}
	}

	result
}

/// Check if a language is supported for highlighting.
/// Returns true if the language has either direct support or a fallback
/// mapping.
#[napi]
pub fn supports_language(lang: String) -> bool {
	if is_known_alias(&lang) {
		return true;
	}

	// Fall back to direct syntax lookup
	let ss = get_syntax_set();
	find_syntax(ss, &lang).is_some()
}

/// Get list of supported languages.
#[napi]
pub fn get_supported_languages() -> Vec<String> {
	let ss = get_syntax_set();
	ss.syntaxes().iter().map(|s| s.name.clone()).collect()
}
