// Done-check evidence: what a run changed, and which checks ran on it since. A shell command
// counts as a check only when a test, type-check, lint, or build runner starts one of its
// segments (`grep -n jest package.json` names a runner but runs none), and its verdict comes from
// the runner's own summary or exit code. A runner whose exit code the shell hides (`npm test |
// tail`, `pytest; echo`) with no summary to read is not counted either way.

import {existsSync, readFileSync} from 'node:fs';
import {join} from 'node:path';

const PM_SCRIPT = String.raw`(?:npm|pnpm|yarn|bun)(?:\s+-{1,2}[^\s]+(?:\s+[^\s]+)?)*\s+(?:run\s+(?:test|check|lint|typecheck|build|verify|ci)|(?:test|check|lint|typecheck|build|verify))\b`;
const YARN_WORKSPACE = String.raw`yarn\s+workspace\s+\S+\s+(?:run\s+)?(?:test|check|lint|typecheck|build|verify|ci)\b`;
const MAKE_TARGET = String.raw`make(?:\s+-[^\s]+(?:\s+[^\s]+)?)*\s+(?:test|check|lint|build)\b`;
const RUNNER_SOURCE = String.raw`${PM_SCRIPT}|${YARN_WORKSPACE}|(?:npx|pnpm|bunx)\s+(?:tsc|jest|vitest|mocha|eslint|biome|prettier\s+--check)\b|pytest|jest|vitest|mocha|tsc|eslint|biome\s+check|ruff|mypy|flake8|pylint|black\s+--check|cargo\s+(?:test|check|build|clippy)|go\s+(?:test|vet|build)|${MAKE_TARGET}|mvn\s+(?:test|verify)|gradle\w*\s+(?:test|check|build)|dotnet\s+(?:test|build)|node\s+--test|deno\s+(?:test|check|lint)|rspec|rake\s+test|mix\s+test|phpunit|swift\s+(?:test|build)|xcodebuild\s+test|ctest|zig\s+(?:test|build)|unittest`;
const RUNNER_START = new RegExp(
	String.raw`^(?:[^\s;&|()]*\/)?(?:${RUNNER_SOURCE})\b`,
);
const WRAPPER_HEAD =
	/^(?:timeout(?:\s+(?:-s|--signal|-k|--kill-after)(?:=|\s+)\S+)*(?:\s+-{1,2}\S+)*\s+\S+|time(?:\s+-p)?|env(?:\s+-{1,2}\S+)*|npx(?:\s+-{1,2}[^\s]+)*|bunx(?:\s+-{1,2}[^\s]+)*|pnpm\s+exec|yarn|uv\s+run(?:\s+--with\s+\S+|\s+-{1,2}[^\s]+)*|poetry\s+run|(?:[^\s;&|()]*\/)?python[\d.]*\s+-m)\s+/;
const ENV_ASSIGN = /^(?:[A-Za-z_][A-Za-z0-9_]*=\S*\s+)+/;
const SHELL_C =
	/^(?:bash|sh|zsh|dash|ksh|fish)\s+-[a-zA-Z]*c\s+(?:'([\s\S]*)'|"([\s\S]*)")\s*$/;
const ZERO_TESTS =
	/Tests:\s+0 total\b|No tests found|\[no tests to run\]|running 0 tests\b|ℹ tests 0\b|no tests ran/i;
const SILENT_RUNNER = /\b(?:tsc|eslint|flake8)\b|\bgo\s+(?:vet|build)\b/;
const PASS_THROUGH: ReadonlySet<string> = new Set([
	'tail',
	'head',
	'tee',
	'cat',
]);
const GENERIC_FAILURE =
	/^\s*(?:make(?:\[\d+\])?:\s+\*\*\*.*Error \d+|npm error (?:Lifecycle script .* failed|code ELIFECYCLE)|npm ERR! code ELIFECYCLE|ELIFECYCLE\s+Command failed with exit code \d+|error Command failed with exit code \d+)/m;
const EXIT_VARIABLE = /\$\?|\$\{PIPESTATUS\[0\]\}/;

interface Piece {
	readonly text: string;
	readonly sep: string | undefined;
	readonly next: string;
}

function commandPieces(command: string): readonly Piece[] {
	const raw: {text: string; sep: string | undefined}[] = [];
	let start = 0;
	for (const match of command.matchAll(/\n|;|&&|\|\||\||(?<!>)&/g)) {
		const index = match.index ?? 0;
		raw.push({text: command.slice(start, index), sep: match[0]});
		start = index + match[0].length;
	}
	raw.push({text: command.slice(start), sep: undefined});
	return raw.map((piece, index) => ({
		...piece,
		next: raw[index + 1]?.text ?? '',
	}));
}

/** Whether a check runner starts the segment, after env assignments, wrappers, and `sh -c`. */
function startsRunner(segment: string, depth = 0): boolean {
	let rest = segment.replace(/^\(+/, '').replace(/\)+$/, '').trim();
	for (;;) {
		rest = rest.replace(ENV_ASSIGN, '').trimStart();
		if (RUNNER_START.test(rest)) return true;
		if (depth < 4) {
			const shell = SHELL_C.exec(rest);
			const inner = shell?.[1] ?? shell?.[2];
			if (
				inner !== undefined &&
				commandPieces(inner).some(piece =>
					startsRunner(piece.text, depth + 1),
				)
			)
				return true;
		}
		const wrapper = WRAPPER_HEAD.exec(rest);
		if (!wrapper) return false;
		rest = rest.slice(wrapper[0].length);
	}
}

function startsCargoBuild(segment: string): boolean {
	let rest = segment.replace(/^\(+/, '').replace(/\)+$/, '').trim();
	for (;;) {
		rest = rest.replace(ENV_ASSIGN, '').trimStart();
		if (/^(?:[^\s;&|()]*\/)?cargo\s+(?:build|check|clippy)\b/.test(rest))
			return true;
		const wrapper = WRAPPER_HEAD.exec(rest);
		if (!wrapper) return false;
		rest = rest.slice(wrapper[0].length);
	}
}

interface Hidden {
	readonly sep: string;
	readonly after: string;
}

/** How the shell hides a runner's exit code: a non-fail-fast pipe, a background `&`, `||`, or more commands after `;`. */
function hiddenCause(
	pieces: readonly Piece[],
	index: number,
	command: string,
): Hidden | undefined {
	const own = pieces[index];
	if (!own) return undefined;
	if (own.sep === '&') return {sep: '&', after: own.next};
	if (own.sep === '|' && !/\bpipefail\b/.test(command))
		return {sep: '|', after: own.next};
	for (let at = index; at < pieces.length; at++) {
		const sep = pieces[at]?.sep;
		if (sep === '||') return {sep: '||', after: pieces[at]?.next ?? ''};
		if (
			(sep === ';' || sep === '\n') &&
			pieces.slice(at + 1).some(piece => piece.text.trim())
		)
			return {sep: ';', after: pieces[at]?.next ?? ''};
	}
	return undefined;
}

/** The line an `echo $?` prints for the runner's exit code, as a pattern with the code captured. */
function codeEcho(text: string): RegExp | undefined {
	const match = /^(?:echo|printf)\b([\s\S]*)$/.exec(text.trim());
	const rest = match?.[1];
	if (rest === undefined || !EXIT_VARIABLE.test(rest)) return undefined;
	const quoted = /(['"])([\s\S]*?)\1/.exec(rest);
	const literal =
		quoted?.[2] && EXIT_VARIABLE.test(quoted[2])
			? quoted[2]
			: quoted?.[2] &&
					/%[sd]/.test(quoted[2]) &&
					EXIT_VARIABLE.test(rest.replace(quoted[0], ''))
				? quoted[2].replace(/%[sd]/, '\uE000')
				: rest.trim();
	const parts = literal
		.replace(/\uE000/g, '$?')
		.replace(/\\n/g, '')
		.split(EXIT_VARIABLE);
	if (parts.length < 2) return undefined;
	const escaped = parts
		.map(part => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
		.join('(\\d+)');
	return new RegExp(`^\\s*${escaped}\\s*$`, 'm');
}

function printedCodePattern(
	pieces: readonly Piece[],
	index: number,
): RegExp | undefined {
	const own = pieces[index];
	if (!own) return undefined;
	if (own.sep === ';' || own.sep === '\n') {
		const next = pieces[index + 1];
		if (next && !/PIPESTATUS/.test(next.text)) return codeEcho(next.text);
	}
	if (own.sep === '|' && !(index > 0 && pieces[index - 1]?.sep === '|')) {
		let at = index;
		while (pieces[at]?.sep === '|') at++;
		const next = pieces[at + 1];
		const sep = pieces[at]?.sep;
		if (
			(sep === ';' || sep === '\n') &&
			next &&
			/PIPESTATUS/.test(next.text)
		)
			return codeEcho(next.text);
	}
	return undefined;
}

function printedCode(pattern: RegExp, output: string): number | undefined {
	const global = new RegExp(pattern.source, `${pattern.flags}g`);
	const matches = [...output.slice(-6000).matchAll(global)];
	const last = matches.at(-1);
	return last ? Number(last[1]) : undefined;
}

function silentOutput(output: string): boolean {
	return (
		output
			.split('\n')
			.map(line => line.trim())
			.filter(
				line =>
					line && !/^> /.test(line) && !/^\(no output\)$/i.test(line),
			).length === 0
	);
}

/** Zero tests reported with no sign of a real run: a run of nothing proves nothing. */
function ranNoTests(output: string): boolean {
	if (!ZERO_TESTS.test(output.slice(-6000))) return false;
	return !output
		.split('\n')
		.some(
			line =>
				/^\s*running [1-9]\d* tests?\b/.test(line) ||
				(/^\s*ok\s/.test(line) && !line.includes('[no tests to run]')),
		);
}

function summaryFailure(tail: string, command: string): boolean {
	for (const match of tail.matchAll(/ℹ fail (\d+)/g))
		if (Number(match[1]) > 0) return true;
	const eslint = /✖ (\d+) problems? \((\d+) errors?, (\d+) warnings?\)/.exec(
		tail,
	);
	const deno =
		/\b(?:ok|FAILED)\s*\|[^\n]*?(\d+) passed\s*\|\s*(\d+) failed/.exec(
			tail,
		);
	return (
		/^Tests:\s+[^\n]*?\b[1-9]\d* failed\b/m.test(tail) ||
		/\b[1-9]\d* (?:failed|errors?)\b[^\n]*\bin [\d.]+s\b/.test(tail) ||
		/^test result: FAILED\./m.test(tail) ||
		/^FAIL\b/m.test(tail) ||
		/^--- FAIL:/m.test(tail) ||
		/\berror TS\d{4}:/.test(tail) ||
		/^\s*(?:\S+:\s*)?(?:Tests|Test Files)\s+[^\n]*?\b[1-9]\d* failed\b/m.test(
			tail,
		) ||
		/^Found [1-9]\d* errors?\b(?![^\n]*\(\d+ fixed, 0 remaining\))/m.test(
			tail,
		) ||
		/\bWould reformat\b/.test(tail) ||
		/\bwould reformat\b/.test(tail) ||
		/\b\d+ files? would be reformatted\b/.test(tail) ||
		/Code style issues found/.test(tail) ||
		(eslint !== null &&
			!/--max-warnings/.test(command) &&
			Number(eslint[2]) > 0) ||
		/^\s*[1-9]\d* failing\s*$/m.test(tail) ||
		/^\s*[1-9]\d* failed\s*$/m.test(tail) ||
		/Some tests failed\./.test(tail) ||
		/^\s*[1-9]\d* fail\s*$/m.test(tail) ||
		(deno !== null && Number(deno[2]) > 0) ||
		/error: could not compile/m.test(tail)
	);
}

function summaryPass(tail: string, command: string): boolean {
	const eslint = /✖ (\d+) problems? \((\d+) errors?, (\d+) warnings?\)/.exec(
		tail,
	);
	const deno =
		/\b(?:ok|FAILED)\s*\|[^\n]*?(\d+) passed\s*\|\s*(\d+) failed/.exec(
			tail,
		);
	return (
		/ℹ (?:tests|pass|fail) \d+/.test(tail) ||
		/^Tests:\s+[^\n]*?\d+ total/m.test(tail) ||
		/^=+ \d+ passed.*? in [\d.]+s =+$/m.test(tail) ||
		/^\d+ passed\b.* in [\d.]+s/m.test(tail) ||
		/^test result: ok\./m.test(tail) ||
		/^ok\s+\S+\s+[\d.]+s$/m.test(tail) ||
		/^\s*(?:\S+:\s*)?Tests\s+\d+ passed\b/m.test(tail) ||
		/^\s*(?:\S+:\s*)?Test Files\s+[^\n]*?\b\d+ passed\b/m.test(tail) ||
		/^Success: no issues found\b/m.test(tail) ||
		/^Found \d+ errors? \(\d+ fixed, 0 remaining\)/m.test(tail) ||
		/^All checks passed!/m.test(tail) ||
		/\b\d+ files? already formatted\b/.test(tail) ||
		/\b\d+ files? would be left unchanged\./.test(tail) ||
		/All matched files use Prettier code style!/.test(tail) ||
		/^Checked \d+ files?\b.*No fixes applied\./m.test(tail) ||
		(eslint !== null &&
			!/--max-warnings/.test(command) &&
			Number(eslint[2]) === 0) ||
		/^\s*\d+ passing \(/m.test(tail) ||
		/^\s*\d+ passed \(/m.test(tail) ||
		/All tests passed!/.test(tail) ||
		/^\s*\d+ pass\s*$/m.test(tail) ||
		/^Ran \d+ tests? across \d+ files?\./m.test(tail) ||
		(deno !== null && Number(deno[2]) === 0) ||
		(/^\s*Finished\b.*\btargets?\b.*\bin \d+(?:\.\d+)?s\b/m.test(tail) &&
			commandPieces(command).some(piece => startsCargoBuild(piece.text)))
	);
}

/** A runner's own summary in its output; a failure marker anywhere beats a pass. */
export function checkSummary(
	output: string,
	command = '',
): 'pass' | 'fail' | undefined {
	const tail = output.slice(-6000);
	if (summaryFailure(tail, command)) return 'fail';
	return summaryPass(tail, command) ? 'pass' : undefined;
}

export type Outcome = 'check-pass' | 'check-fail' | 'unknown';

/** What one finished shell command says about the code: a passing check, a failing one, or nothing. */
export function classifyShell(params: {
	readonly command: string;
	readonly failed: boolean;
	readonly output: string;
}): Outcome {
	const {failed, output} = params;
	const command = params.command.replace(/\\\r?\n/g, '');
	const summary = checkSummary(output, command);
	const runners = commandPieces(command).flatMap((piece, index, pieces) =>
		startsRunner(piece.text)
			? [
					{
						text: piece.text,
						hides: hiddenCause(pieces, index, command),
						printed: printedCodePattern(pieces, index),
					},
				]
			: [],
	);
	if (runners.length === 0 && summary === undefined) return 'unknown';
	if (ranNoTests(output)) return 'unknown';
	const verdict =
		runners.length > 0 && GENERIC_FAILURE.test(output.slice(-6000))
			? 'fail'
			: summary;
	const evidence = runners.map(runner => {
		const head =
			runner.hides?.after.trim().split(/\s+/)[0]?.replace(/^-+/, '') ??
			'';
		return {
			code:
				runner.printed === undefined
					? undefined
					: printedCode(runner.printed, output),
			silent:
				runner.hides?.sep === '|' &&
				PASS_THROUGH.has(head) &&
				SILENT_RUNNER.test(runner.text) &&
				silentOutput(output),
		};
	});
	const anyPrintedFail = evidence.some(
		entry => entry.code !== undefined && entry.code !== 0,
	);
	const visible = (index: number): boolean => {
		const runner = runners[index];
		const entry = evidence[index];
		return (
			runner?.hides === undefined ||
			entry?.code !== undefined ||
			entry?.silent === true
		);
	};
	const someVisible = runners.some((_runner, index) => visible(index));
	const allCovered = runners.every(
		(_runner, index) => verdict !== undefined || visible(index),
	);
	const isHidden = runners.some(runner => runner.hides !== undefined);
	if (isHidden && verdict === undefined && !anyPrintedFail && !allCovered)
		return failed && someVisible ? 'check-fail' : 'unknown';
	return verdict === 'fail' || failed || anyPrintedFail
		? 'check-fail'
		: 'check-pass';
}

// ── Run evidence ───────────────────────────────────────────────────────────────────────────────

export interface Check {
	readonly call: string;
	readonly passed: boolean;
}

export interface Evidence {
	readonly mutations: number;
	readonly checks: readonly Check[];
	// How many checks had run when the latest change landed: only later ones checked it.
	readonly checksBeforeMutation: number;
}

export const EMPTY_EVIDENCE: Evidence = {
	mutations: 0,
	checks: [],
	checksBeforeMutation: 0,
};

export function withMutation(evidence: Evidence): Evidence {
	return {
		...evidence,
		mutations: evidence.mutations + 1,
		checksBeforeMutation: evidence.checks.length,
	};
}

export function withCheck(evidence: Evidence, check: Check): Evidence {
	return {...evidence, checks: [...evidence.checks, check]};
}

export function freshChecks(evidence: Evidence): readonly Check[] {
	return evidence.checks.slice(evidence.checksBeforeMutation);
}

export function needsDoneCheck(evidence: Evidence): boolean {
	return (
		evidence.mutations > 0 &&
		!freshChecks(evidence).some(check => check.passed)
	);
}

// A reply that presents the work as finished. Questions, blockers, and named remaining work do not.
const CLAIMS_DONE =
	/\b(?:done|fixed|implemented|complete(?:d)?|finished|resolved|all set|ready|works now|working now|now works|should (?:now )?work|in place)\b/i;
const NOT_DONE =
	/\?\s*$|\b(?:remaining|still need|not yet|next step|todo|blocked|unable to|could not|couldn't|can't|cannot|haven't|partial(?:ly)?|unverified|didn't run|did not run)\b/i;

export function claimsDone(finalText: string): boolean {
	const text = finalText.trim();
	return text.length > 0 && CLAIMS_DONE.test(text) && !NOT_DONE.test(text);
}

function packageManager(root: string): string {
	const locks: readonly [string, string][] = [
		['pnpm-lock.yaml', 'pnpm'],
		['yarn.lock', 'yarn'],
		['bun.lockb', 'bun'],
		['bun.lock', 'bun'],
	];
	return locks.find(([lock]) => existsSync(join(root, lock)))?.[1] ?? 'npm';
}

function readRootFile(path: string): string {
	try {
		return existsSync(path) ? readFileSync(path, 'utf8') : '';
	} catch {
		return '';
	}
}

/** The project's own check command: its `check` or `test` script, else the same Makefile target. */
export function projectCheckCommand(root: string): string | undefined {
	const scripts = (() => {
		try {
			const parsed: unknown = JSON.parse(
				readRootFile(join(root, 'package.json')) || '{}',
			);
			const value = (parsed as {scripts?: unknown}).scripts;
			return value && typeof value === 'object'
				? (value as Record<string, unknown>)
				: {};
		} catch {
			return {};
		}
	})();
	const script = ['check', 'test'].find(
		name => typeof scripts[name] === 'string',
	);
	if (script) return `${packageManager(root)} run ${script}`;
	const makefile = readRootFile(join(root, 'Makefile'));
	const target = ['check', 'test'].find(name =>
		new RegExp(`^${name}\\s*:`, 'm').test(makefile),
	);
	return target ? `make ${target}` : undefined;
}

/** What the agent is sent back with: verify, or say plainly that nothing was verified. */
export function doneNudge(params: {
	readonly evidence: Evidence;
	readonly lastCheck?: string;
	readonly projectCheck?: string;
}): string {
	const {evidence} = params;
	const failed = freshChecks(evidence).filter(check => !check.passed);
	const reason = `reports completion after ${evidence.mutations} file change${evidence.mutations === 1 ? '' : 's'} with ${failed.length > 0 ? `${failed.length} failed check${failed.length === 1 ? '' : 's'} and no passing one` : 'no test, build, or lint run since the last change'}`;
	const command = params.lastCheck ?? params.projectCheck;
	const detail =
		failed.length > 0
			? `The last check that ran failed: ${failed.at(-1)?.call}. Fix that first.`
			: command !== undefined
				? `Run ${command} on what you changed.`
				: "Run the project's tests, build, or lint (whatever exists) on what you changed.";
	return `rules-warden: ${reason}. ${detail} Then report the actual result. If no check exists or can run, say so explicitly instead of presenting the work as done.`;
}
