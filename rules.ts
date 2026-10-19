// Project rules: where they come from and how a markdown file becomes a list of rules.
//
// `warden.md` at the project root wins. Without one, the first of AGENTS.md, CLAUDE.md, and
// README.md that exists is used: judged as one document when it reads like rules (a bullet list or
// a "must", "never", "always" line near the top of a section), and not judged at all when it is
// prose only. In a rules file, every heading at the highest level used is one rule, and the text
// under it is what the judge reads. Header lines right under a heading tune the rule:
//   paths: src/**/*.ts, migrations/**    only for matching files
//   threshold: 0.8                       how sure the judge must be (0 to 1)
//   severity: high | normal | low        ordering when several rules break at once

import {readFileSync, statSync} from 'node:fs';
import {isAbsolute, relative, resolve, sep} from 'node:path';

export const RULES_FILE = 'warden.md';
export const FALLBACK_FILES: readonly string[] = [
	'AGENTS.md',
	'CLAUDE.md',
	'README.md',
];
export const MAX_RULES = 31;
const ID_LIMIT = 64;
const RULE_SHAPE_CONTEXT_LINES = 15;
const AGGREGATE_MAX_CHARS = 6000;

export type Severity = 'high' | 'normal' | 'low';

export interface Rule {
	readonly id: string;
	readonly name: string;
	readonly body: string;
	readonly paths: readonly string[];
	readonly threshold?: number;
	readonly severity?: Severity;
	// `when: turn` rules judge a whole run's diff in the original; they are not judged here.
	readonly perTurn?: boolean;
	readonly warnings?: readonly string[];
}

export interface RuleSet {
	readonly source: string;
	readonly rules: readonly Rule[];
	// A fallback document with no rule headings, judged as a whole.
	readonly aggregate?: string;
}

const FENCE = /^\s{0,3}(`{3,}|~{3,})/;
const HEADING = /^(#{1,6})\s+(.+?)\s*#*\s*$/;
const PATHS_LINE = /^\s*(?:paths?|applies to|files?)\s*:\s*(.+?)\s*$/i;
const THRESHOLD_LINE = /^\s*threshold\s*:\s*(.+?)\s*$/i;
const SEVERITY_LINE = /^\s*severity\s*:\s*(.+?)\s*$/i;
const WHEN_LINE = /^\s*when\s*:\s*(.+?)\s*$/i;
const SOURCE_LINE = /^\s*source\s*:\s*(.+?)\s*$/i;
const MODAL_WORDS =
	/^(?:must|shall|never|always|do not|don't|cannot|can't|avoid|prefer|require|should not|shouldn't|no |not )/i;
const BULLET_LINE = /^\s*[-*+]\s|^\s*\d+\.\s/;
const SEVERITIES: readonly string[] = ['high', 'normal', 'low'];

interface TaggedLine {
	readonly text: string;
	readonly fenced: boolean;
}

/** Lines marked when they sit inside a fenced code block, where `#` is code, not a heading. */
function taggedLines(markdown: string): readonly TaggedLine[] {
	const out: TaggedLine[] = [];
	let fence: string | undefined;
	for (const text of markdown.split(/\r\n|\r|\n/)) {
		const marker = FENCE.exec(text)?.[1];
		if (marker) {
			if (!fence) fence = marker;
			else if (marker[0] === fence[0] && marker.length >= fence.length)
				fence = undefined;
			out.push({text, fenced: true});
			continue;
		}
		out.push({text, fenced: fence !== undefined});
	}
	return out;
}

function ruleLevel(lines: readonly TaggedLine[]): number {
	return lines.reduce((level, line) => {
		if (line.fenced) return level;
		const match = HEADING.exec(line.text);
		return match?.[1] && match[1].length < level ? match[1].length : level;
	}, 7);
}

function slug(name: string, used: Set<string>): string {
	const full = name
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-+|-+$/g, '');
	const base =
		(full.length <= ID_LIMIT
			? full
			: full.slice(0, ID_LIMIT).replace(/-[^-]*$/, '')) || 'rule';
	let candidate = base;
	for (let n = 2; used.has(candidate); n++) candidate = `${base}-${n}`;
	used.add(candidate);
	return candidate;
}

/** The rules of a markdown file: one per heading at the highest heading level it uses. */
export function parseRules(markdown: string): readonly Rule[] {
	const lines = taggedLines(markdown);
	const level = ruleLevel(lines);
	if (level === 7) return [];
	const drafts: {name: string; lines: string[]}[] = [];
	for (const line of lines) {
		const match = line.fenced ? null : HEADING.exec(line.text);
		if (match?.[1] && match[1].length === level && match[2]) {
			drafts.push({name: match[2], lines: []});
			continue;
		}
		drafts.at(-1)?.lines.push(line.text);
	}
	const used = new Set<string>();
	return drafts.map(draft => {
		const body = [...draft.lines];
		const warnings: string[] = [];
		let paths: readonly string[] = [];
		let threshold: number | undefined;
		let severity: Severity | undefined;
		let perTurn = false;
		const seen = new Set<string>();
		// Header lines may come in any order, once each; they never stay in the body.
		for (;;) {
			const first = body.findIndex(text => text.trim());
			if (first < 0) break;
			const line = body[first] ?? '';
			const header =
				(PATHS_LINE.test(line) && 'paths') ||
				(THRESHOLD_LINE.test(line) && 'threshold') ||
				(SEVERITY_LINE.test(line) && 'severity') ||
				(WHEN_LINE.test(line) && 'when') ||
				(SOURCE_LINE.test(line) && 'source') ||
				undefined;
			if (!header) break;
			body.splice(first, 1);
			if (seen.has(header)) {
				warnings.push(
					`${header}: appears more than once; the first is kept`,
				);
				continue;
			}
			seen.add(header);
			if (header === 'paths')
				paths = (PATHS_LINE.exec(line)?.[1] ?? '')
					.split(/[,\s]+/)
					.map(glob => glob.replace(/^`|`$/g, ''))
					.filter(Boolean);
			if (header === 'threshold') {
				const raw = (THRESHOLD_LINE.exec(line)?.[1] ?? '')
					.replace(/^`|`$/g, '')
					.trim();
				const value = Number(raw);
				if (
					raw === '' ||
					!Number.isFinite(value) ||
					value < 0 ||
					value > 1
				)
					warnings.push(
						`threshold: ${raw || '(empty)'} is not a number from 0 to 1; ignored`,
					);
				else threshold = value;
			}
			if (header === 'severity') {
				const raw = (SEVERITY_LINE.exec(line)?.[1] ?? '')
					.trim()
					.toLowerCase();
				if (SEVERITIES.includes(raw)) severity = raw as Severity;
				else
					warnings.push(
						`severity: ${raw || '(empty)'} is not high, normal, or low; ignored`,
					);
			}
			if (header === 'when')
				perTurn = /^turn$/i.test(
					(WHEN_LINE.exec(line)?.[1] ?? '').trim(),
				);
		}
		return {
			id: slug(draft.name, used),
			name: draft.name.trim(),
			body: body.join('\n').trim(),
			paths,
			...(threshold === undefined ? {} : {threshold}),
			...(severity === undefined ? {} : {severity}),
			...(perTurn ? {perTurn} : {}),
			...(warnings.length > 0 ? {warnings} : {}),
		};
	});
}

/**
 * Whether a document reads like rules: some section has a bullet list or a line starting with a
 * modal ("must", "never", "always", "do not", "avoid", "prefer") near its top.
 */
export function isRuleShaped(markdown: string): boolean {
	const lines = taggedLines(markdown);
	const level = ruleLevel(lines);
	if (level === 7) return false;
	let inSection = false;
	let linesInBody = 0;
	for (const line of lines) {
		if (line.fenced) continue;
		const heading = HEADING.exec(line.text);
		if (heading?.[1] && heading[1].length === level) {
			inSection = true;
			linesInBody = 0;
			continue;
		}
		if (!inSection) continue;
		linesInBody++;
		if (linesInBody > RULE_SHAPE_CONTEXT_LINES) {
			inSection = false;
			continue;
		}
		if (BULLET_LINE.test(line.text) || MODAL_WORDS.test(line.text.trim()))
			return true;
	}
	return false;
}

/**
 * A long document cut to `limit` characters keeping its shape: every heading stays and each
 * section keeps its head, so a rule in the last section of a long AGENTS.md is still seen.
 */
export function condense(text: string, limit: number): string {
	if (text.length <= limit) return text;
	const sections: {heading?: string; body: string[]}[] = [{body: []}];
	for (const line of taggedLines(text)) {
		if (!line.fenced && HEADING.test(line.text))
			sections.push({heading: line.text, body: []});
		else sections.at(-1)?.body.push(line.text);
	}
	const headings = sections.reduce(
		(sum, item) => sum + (item.heading?.length ?? 0) + 4,
		0,
	);
	const perSection = Math.max(
		80,
		Math.floor((limit - headings) / sections.length),
	);
	const out = sections
		.map(item => {
			const body = item.body.join('\n').trim();
			const cut =
				body.length <= perSection
					? body
					: `${body.slice(0, perSection)}…`;
			return `${item.heading ? `${item.heading}\n` : ''}${cut}`;
		})
		.join('\n\n')
		.trim();
	return out.length <= limit
		? out
		: `${out.slice(0, limit)}… [${text.length - limit} more chars in the document]`;
}

// Globs: `**/` any depth, `*` within a segment, `?` one character. Unanchored at the start, so
// `migrations/**` matches `db/migrations/0182.sql`. Paths are project-relative with `/`.
export function globToRegExp(pattern: string): RegExp {
	let out = '';
	for (let index = 0; index < pattern.length; ) {
		if (pattern.startsWith('**/', index)) {
			out += '(?:.*/)?';
			index += 3;
		} else if (pattern.startsWith('**', index)) {
			out += '.*';
			index += 2;
		} else if (pattern[index] === '*') {
			out += '[^/]*';
			index += 1;
		} else if (pattern[index] === '?') {
			out += '[^/]';
			index += 1;
		} else {
			out += (pattern[index] ?? '').replace(
				/[.*+?^${}()|[\]\\]/g,
				'\\$&',
			);
			index += 1;
		}
	}
	return new RegExp(`^(?:.*/)?${out}$`);
}

export function matchGlob(path: string, patterns: readonly string[]): boolean {
	const normalized = path.replace(/^\.\//, '');
	return patterns.some(pattern =>
		globToRegExp(pattern.trim()).test(normalized),
	);
}

/** Project-relative path with `/`, or undefined when the target is outside the project. */
export function projectPath(target: string, cwd: string): string | undefined {
	const rel = relative(resolve(cwd), resolve(cwd, target));
	if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) return undefined;
	return rel.split(sep).join('/');
}

function readFile(path: string): string | undefined {
	try {
		if (!statSync(path).isFile()) return undefined;
		return readFileSync(path, 'utf8');
	} catch {
		return undefined;
	}
}

/** The project's rule set, or undefined when it has none to judge against. */
export function loadRules(cwd: string): RuleSet | undefined {
	const own = readFile(resolve(cwd, RULES_FILE));
	if (own !== undefined) {
		const rules = parseRules(own);
		if (rules.length > 0) return {source: RULES_FILE, rules};
		return own.trim()
			? {
					source: RULES_FILE,
					rules: [],
					aggregate: condense(own, AGGREGATE_MAX_CHARS),
				}
			: undefined;
	}
	for (const file of FALLBACK_FILES) {
		const text = readFile(resolve(cwd, file));
		if (!text?.trim()) continue;
		// A prose-only README is not a list of rules: judging against it would be noise.
		if (!isRuleShaped(text)) return undefined;
		return {
			source: file,
			rules: [],
			aggregate: condense(text, AGGREGATE_MAX_CHARS),
		};
	}
	return undefined;
}

/** Rules that apply to a write at `path`: unscoped ones, plus those whose `paths` match. */
export function rulesFor(set: RuleSet, path: string): readonly Rule[] {
	return set.rules
		.filter(rule => !rule.perTurn)
		.filter(rule => rule.paths.length === 0 || matchGlob(path, rule.paths))
		.slice(0, MAX_RULES);
}

export const STARTER_RULES = `# No hardcoded secrets
Source code must not contain passwords, API keys, tokens, or connection URLs with credentials.
Read them from the environment, a function parameter, or the config module.

# Comments explain why, not what
A comment states a reason, a constraint, a workaround, or a non-obvious invariant. A comment
that restates what the next line plainly does is a violation.

# Errors are not swallowed
A \`catch\` block must handle the error, report it, or re-raise it. An empty catch block, or
one whose body is only a comment, is a violation.

# No partial implementations
Implement features fully. A comment that says "for now", "simplified", or "later", or a
stub body, is a violation. If a part genuinely cannot be done, say so in your reply instead
of stubbing it.
`;

export const TYPESCRIPT_RULES = `
# No explicit any
paths: **/*.ts, **/*.tsx
Do not use the \`any\` type. Use a precise type, \`unknown\` with a runtime check, or a generic parameter.

# Exported functions declare their return type
paths: src/**/*.ts
Every exported function or method declares its return type instead of relying on inference.
`;
