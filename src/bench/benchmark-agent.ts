#!/usr/bin/env node
/**
 * Benchmark comparing Claude Agent SDK performance with and without osgrep
 * 
 * This benchmark demonstrates the value of osgrep by comparing:
 * - Speed: Time to complete the task
 * - Cost: Token usage and USD cost
 * - Efficiency: Number of tool calls and files read
 * 
 * Uses the Claude Agent SDK (not Skills API) so Claude can call the osgrep CLI
 * via the Bash tool on the local system with pre-indexed repositories.
 */

import { query } from '@anthropic-ai/claude-agent-sdk';
import type { SDKResultMessage } from '@anthropic-ai/claude-agent-sdk';
import { join } from 'path';
import chalk from 'chalk';
import fs from 'fs';
import { config } from 'dotenv';
config({ path: '.env.local' });



interface BenchmarkResult {
	duration_ms: number;
	cost_usd: number;
	input_tokens: number;
	output_tokens: number;
	cache_creation_tokens?: number;
	cache_read_tokens?: number;
	tool_calls: number;
	files_read: number;
	grep_calls: number;
	bash_calls: number;
	read_bytes: number;
	estimated_read_tokens: number;
	result: string;
	error?: string;
}

interface BenchmarkComparison {
	question: string;
	repository: string;
	without_osgrep: BenchmarkResult | null;
	with_osgrep: BenchmarkResult | null;
}

/**
 * Run a single test with or without osgrep plugin/skill
 */
async function runTest(
	question: string,
	repoPath: string,
	useOsgrep: boolean
): Promise<BenchmarkResult> {
	const startTime = Date.now();
	let toolCalls = 0;
	let filesRead = 0;
	let grepCalls = 0;
	let bashCalls = 0;
	let readBytes = 0;

	try {
		// Build a detailed system prompt that encourages thorough searching
		const systemPrompt = useOsgrep
			? `You are a thorough code analysis assistant. Your goal is to provide comprehensive, well-researched answers about codebases.

IMPORTANT: You have access to osgrep, a semantic code search tool. This is MUCH more efficient than grep for conceptual queries.

When answering questions:
1. First use osgrep with --json to find relevant code semantically
2. Read the specific files osgrep suggests
3. Provide detailed analysis based on what you find

The repository is already indexed. Use osgrep for all conceptual/semantic searches.`
			: `You are a thorough code analysis assistant. Your goal is to provide comprehensive, well-researched answers about codebases.

When answering questions:
1. Use Grep to search for relevant patterns and keywords
2. Use Glob to find relevant files
3. Read files to understand implementation details
4. Explore multiple files to get a complete picture
5. Provide detailed analysis based on what you find

Be thorough - search widely before concluding.`;

		// Build query options
		const options: any = {
			cwd: repoPath,
			systemPrompt,
			allowedTools: useOsgrep 
				? ['Read', 'Grep', 'Glob', 'Bash'] 
				: ['Read', 'Grep', 'Glob'], // No Bash without osgrep
			// ALSO explicitly disallow Bash when not using osgrep
			disallowedTools: useOsgrep ? [] : ['Bash'],
			permissionMode: 'bypassPermissions' as const, // Auto-approve for benchmarking
			maxTurns: 50, // Allow many turns for thorough exploration
		};
		
		// Debug: Log the tool configuration
		console.log(chalk.dim(`   Tools config: allowed=${JSON.stringify(options.allowedTools)}, disallowed=${JSON.stringify(options.disallowedTools)}`));

		// Load osgrep plugin/skill if enabled
		if (useOsgrep) {
			// Load the osgrep plugin which contains the skill
			options.plugins = [
				{
					type: 'local' as const,
					path: join(__dirname, '../plugins/osgrep')
				}
			];
		}

		// Enhance the prompt to encourage thorough investigation
		const enhancedPrompt = `${question}

Please provide a comprehensive answer by:
1. Searching the codebase thoroughly
2. Reading relevant files
3. Explaining the implementation with specific code references
4. Covering all major aspects of the question

Be thorough and cite specific files and code.`;

		// Execute the query using Agent SDK
		const result = query({
			prompt: enhancedPrompt,
			options
		});

		let finalResult: SDKResultMessage | null = null;
		let resultText = '';

		// Collect results from the async generator
		for await (const msg of result) {
			// Log progress for visibility
			if (msg.type === 'assistant' && 'message' in msg) {
				const assistantMsg = msg.message;
				if (Array.isArray(assistantMsg.content)) {
					for (const block of assistantMsg.content) {
						if (block.type === 'tool_use') {
							toolCalls++;
							// Count specific tool types based on name
							const toolName = block.name;
							
							// Debug: Log unexpected tool usage
							if (toolName === 'Bash' && !useOsgrep) {
								console.log(chalk.red(`\n   ⚠️  WARNING: Bash tool used when it should be disallowed!`));
							}
							
							if (toolName === 'Read') {
								filesRead++;
								// Approximate how many tokens were consumed by reading files:
								// use file byte size as a proxy (avg 4 chars per token).
								const pathInput =
									typeof block.input === 'object' && block.input !== null
										? (block.input as { path?: string }).path
										: undefined;
								if (pathInput && typeof pathInput === 'string') {
									try {
										const stat = fs.statSync(pathInput);
										if (stat.isFile()) {
											readBytes += stat.size;
										}
									} catch {
										// Ignore missing files / stat errors
									}
								}
								process.stdout.write(chalk.dim('.'));
							} else if (toolName === 'Bash') {
								bashCalls++;
								process.stdout.write(chalk.cyan('o'));
							} else if (toolName === 'Grep') {
								grepCalls++;
								process.stdout.write(chalk.yellow('g'));
							} else if (toolName === 'Glob') {
								process.stdout.write(chalk.dim('*'));
							}
						}
					}
				}
			}

			// Extract final result
			if (msg.type === 'result') {
				process.stdout.write('\n'); // New line after progress dots
				finalResult = msg as SDKResultMessage;
				if (msg.subtype === 'success') {
					resultText = msg.result;
				}
			}
		}

		if (!finalResult) {
			throw new Error('No result message received');
		}

		const duration_ms = Date.now() - startTime;

		return {
			duration_ms,
			cost_usd: finalResult.total_cost_usd,
			input_tokens: finalResult.usage.input_tokens,
			output_tokens: finalResult.usage.output_tokens,
			cache_creation_tokens: finalResult.usage.cache_creation_input_tokens,
			cache_read_tokens: finalResult.usage.cache_read_input_tokens,
			tool_calls: toolCalls,
			files_read: filesRead,
			grep_calls: grepCalls,
			bash_calls: bashCalls,
			read_bytes: readBytes,
			estimated_read_tokens: Math.ceil(readBytes / 4),
			result: resultText
		};
	} catch (error) {
		return {
			duration_ms: Date.now() - startTime,
			cost_usd: 0,
			input_tokens: 0,
			output_tokens: 0,
			tool_calls: 0,
			files_read: 0,
			grep_calls: 0,
			bash_calls: 0,
			read_bytes: 0,
			estimated_read_tokens: 0,
			result: '',
			error: error instanceof Error ? error.message : String(error)
		};
	}
}


/**
 * Run a complete benchmark comparison
 */
async function runBenchmark(
	question: string,
	repoPath: string
): Promise<BenchmarkComparison> {
	console.log(chalk.bold('\n🔬 Running Benchmark'));
	console.log(chalk.dim('─'.repeat(60)));
	console.log(chalk.cyan('Question:'), question);
	console.log(chalk.cyan('Repository:'), repoPath);
	console.log(chalk.dim('─'.repeat(60)));

	// Run test WITHOUT osgrep plugin
	console.log(chalk.yellow('\n⏱️  Running WITHOUT osgrep skill...'));
	console.log(chalk.dim('   (Using only: Read, Grep, Glob)'));
	process.stdout.write(chalk.dim('   Progress: '));
	const withoutOsgrep = await runTest(question, repoPath, false);
	
	if (withoutOsgrep.error) {
		console.log(chalk.red('✗ Failed:'), withoutOsgrep.error);
	} else {
		console.log(chalk.green(`✓ Completed in ${(withoutOsgrep.duration_ms / 1000).toFixed(1)}s`));
	}

	// Run test WITH osgrep plugin/skill
	console.log(chalk.yellow('\n⏱️  Running WITH osgrep skill...'));
	console.log(chalk.dim('   (Using: Read, Grep, Glob, osgrep via Bash)'));
	process.stdout.write(chalk.dim('   Progress: '));
	const withOsgrep = await runTest(question, repoPath, true);
	
	if (withOsgrep.error) {
		console.log(chalk.red('✗ Failed:'), withOsgrep.error);
	} else {
		console.log(chalk.green(`✓ Completed in ${(withOsgrep.duration_ms / 1000).toFixed(1)}s`));
	}

	return {
		question,
		repository: repoPath,
		without_osgrep: withoutOsgrep,
		with_osgrep: withOsgrep
	};
}

/**
 * Display benchmark results in a formatted table
 */
function displayResults(comparison: BenchmarkComparison): void {
	const { without_osgrep: without, with_osgrep: with_ } = comparison;

	if (!without || !with_) {
		console.log(chalk.red('\n❌ Incomplete benchmark results'));
		return;
	}

	console.log(chalk.bold('\n📊 Benchmark Results'));
	console.log(chalk.dim('═'.repeat(80)));

	// Calculate improvements
	const timeImprovement = without.duration_ms / with_.duration_ms;
	const costSavings = percentDelta(without.cost_usd, with_.cost_usd);
	const tokenReduction = percentDelta(without.input_tokens, with_.input_tokens);
	const readTokenReduction = percentDelta(
		without.estimated_read_tokens,
		with_.estimated_read_tokens
	);
	const toolCallReduction = percentDelta(without.tool_calls, with_.tool_calls);
	const fileReadReduction = percentDelta(without.files_read, with_.files_read);

	// Create comparison table
	console.log('\n┌─────────────────────┬──────────────┬──────────────┬─────────────┐');
	console.log('│                     │ WITHOUT      │ WITH         │ IMPROVEMENT │');
	console.log('│                     │ osgrep       │ osgrep       │             │');
	console.log('├─────────────────────┼──────────────┼──────────────┼─────────────┤');
	
	console.log(`│ Time                │ ${formatDuration(without.duration_ms).padEnd(12)} │ ${formatDuration(with_.duration_ms).padEnd(12)} │ ${formatImprovement(timeImprovement, 'x faster').padEnd(11)} │`);
	console.log(`│ Cost                │ ${formatCost(without.cost_usd).padEnd(12)} │ ${formatCost(with_.cost_usd).padEnd(12)} │ ${formatPercent(costSavings, 'cheaper').padEnd(11)} │`);
	console.log(`│ Input Tokens        │ ${formatNumber(without.input_tokens).padEnd(12)} │ ${formatNumber(with_.input_tokens).padEnd(12)} │ ${formatPercent(tokenReduction, 'less').padEnd(11)} │`);
	console.log(`│ Read Tokens (est)   │ ${formatNumber(without.estimated_read_tokens).padEnd(12)} │ ${formatNumber(with_.estimated_read_tokens).padEnd(12)} │ ${formatPercent(readTokenReduction, 'less').padEnd(11)} │`);
	console.log(`│ Output Tokens       │ ${formatNumber(without.output_tokens).padEnd(12)} │ ${formatNumber(with_.output_tokens).padEnd(12)} │ ${formatDiff(without.output_tokens, with_.output_tokens).padEnd(11)} │`);
	console.log(`│ Tool Calls (Total)  │ ${formatNumber(without.tool_calls).padEnd(12)} │ ${formatNumber(with_.tool_calls).padEnd(12)} │ ${formatPercent(toolCallReduction, 'less').padEnd(11)} │`);
	console.log(`│ Files Read          │ ${formatNumber(without.files_read).padEnd(12)} │ ${formatNumber(with_.files_read).padEnd(12)} │ ${formatPercent(fileReadReduction, 'less').padEnd(11)} │`);
	console.log(`│ Grep Searches       │ ${formatNumber(without.grep_calls).padEnd(12)} │ ${formatNumber(with_.grep_calls).padEnd(12)} │ ${formatDiff(without.grep_calls, with_.grep_calls).padEnd(11)} │`);
	console.log(`│ osgrep Searches     │ ${formatNumber(without.bash_calls).padEnd(12)} │ ${formatNumber(with_.bash_calls).padEnd(12)} │ ${formatDiff(without.bash_calls, with_.bash_calls).padEnd(11)} │`);
	
	console.log('└─────────────────────┴──────────────┴──────────────┴─────────────┘');
	
	// Add legend
	console.log(chalk.dim('\nProgress indicators: ') + chalk.dim('.') + chalk.dim('=Read ') + chalk.yellow('g') + chalk.dim('=Grep ') + chalk.cyan('o') + chalk.dim('=osgrep ') + chalk.dim('*=Glob'));

	// Summary
	console.log(chalk.bold('\n💡 Summary'));
	console.log(chalk.dim('─'.repeat(60)));
	
	if (timeImprovement > 1.5) {
		console.log(chalk.green(`✓ osgrep is ${timeImprovement.toFixed(1)}x faster`));
	}
	
	if (costSavings > 30) {
		console.log(chalk.green(`✓ osgrep saves ${costSavings.toFixed(0)}% in cost`));
	}
	
	if (tokenReduction > 50) {
		console.log(chalk.green(`✓ osgrep reduces input tokens by ${tokenReduction.toFixed(0)}%`));
	}
	if (readTokenReduction > 50) {
		console.log(chalk.green(`✓ osgrep cuts read tokens by ${readTokenReduction.toFixed(0)}%`));
	}

	console.log(chalk.dim('─'.repeat(60)));
}

// Formatting helpers
function formatDuration(ms: number): string {
	return `${(ms / 1000).toFixed(1)}s`;
}

function formatCost(usd: number): string {
	return `$${usd.toFixed(4)}`;
}

function formatNumber(n: number): string {
	return n.toLocaleString();
}

function formatImprovement(ratio: number, suffix: string): string {
	return `${ratio.toFixed(1)}${suffix}`;
}

function formatPercent(percent: number, suffix: string): string {
	if (!Number.isFinite(percent)) return 'N/A';
	return `${percent.toFixed(0)}% ${suffix}`;
}

function formatDiff(before: number, after: number): string {
	const diff = ((after - before) / before) * 100;
	if (Math.abs(diff) < 1) return 'similar';
	return diff > 0 ? `+${diff.toFixed(0)}%` : `${diff.toFixed(0)}%`;
}

function percentDelta(before: number, after: number): number {
	if (before === 0) return NaN;
	return ((before - after) / before) * 100;
}

// Main execution
async function main() {
	const question = process.argv[2];
	const repoPath = process.argv[3] || process.cwd();
	const outputFile = process.argv[4]; // Optional: path to save JSON results

	if (!question) {
		console.error(chalk.red('Usage: benchmark-agent <question> [repo-path] [output-json]'));
		console.error(chalk.dim('Example: benchmark-agent "How does authentication work?" ./my-repo results.json'));
		process.exit(1);
	}

	if (!process.env.ANTHROPIC_API_KEY) {
		console.error(chalk.red('Error: ANTHROPIC_API_KEY environment variable not set'));
		process.exit(1);
	}

	try {
		const comparison = await runBenchmark(question, repoPath);
		displayResults(comparison);
		
		// Save results to JSON if output file specified
		if (outputFile) {
			await saveResults(comparison, outputFile);
		}
	} catch (error) {
		console.error(chalk.red('Benchmark failed:'), error);
		process.exit(1);
	}
}

/**
 * Save benchmark results to JSON file
 */
async function saveResults(comparison: BenchmarkComparison, filepath: string): Promise<void> {
	const fs = await import('fs/promises');
	const path = await import('path');
	
	// Load existing results if file exists
	let allResults: BenchmarkComparison[] = [];
	try {
		const existing = await fs.readFile(filepath, 'utf-8');
		allResults = JSON.parse(existing);
	} catch {
		// File doesn't exist yet, start fresh
	}
	
	// Add timestamp to the comparison
	const resultWithTimestamp = {
		...comparison,
		timestamp: new Date().toISOString(),
		repository_name: path.basename(comparison.repository)
	};
	
	allResults.push(resultWithTimestamp);
	
	// Save back to file
	await fs.writeFile(filepath, JSON.stringify(allResults, null, 2), 'utf-8');
	console.log(chalk.green(`\n✓ Results saved to ${filepath}`));
}

if (require.main === module) {
	main();
}

export { runBenchmark, displayResults, saveResults };
