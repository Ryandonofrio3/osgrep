#!/usr/bin/env node
/**
 * Generate benchmark visualization and update README
 * 
 * Reads benchmark results from JSON and creates:
 * - ASCII bar charts comparing metrics
 * - Summary statistics
 * - Updates README.md with results
 */

import { readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import chalk from 'chalk';

interface BenchmarkResult {
	duration_ms: number;
	cost_usd: number;
	input_tokens: number;
	output_tokens: number;
	tool_calls: number;
	files_read: number;
	grep_calls: number;
	bash_calls: number;
}

interface BenchmarkComparison {
	question: string;
	repository: string;
	repository_name: string;
	timestamp: string;
	without_osgrep: BenchmarkResult;
	with_osgrep: BenchmarkResult;
}

/**
 * Create a beautiful orange & black ASCII bar chart
 */
function createBarChart(label: string, value: number, maxValue: number, width: number = 30, isOrange: boolean = false): string {
	const barWidth = Math.round((value / maxValue) * width);
	
	// Use different block characters for orange vs black
	// Orange: ▓ (dark shade) or ▒ (medium shade) 
	// Black: █ (solid block)
	const barChar = isOrange ? '▓' : '█';
	const bar = barChar.repeat(barWidth);
	const empty = '░'.repeat(width - barWidth);
	
	// Format the value nicely
	let displayValue: string;
	if (value < 1) {
		displayValue = `$${value.toFixed(4)}`;
	} else if (value < 100) {
		displayValue = value.toFixed(1);
	} else {
		displayValue = value.toFixed(0);
	}
	
	return `${label} │${bar}${empty}│ ${displayValue}`;
}

/**
 * Calculate average improvement across all benchmarks
 */
function calculateAverages(results: BenchmarkComparison[]) {
	const metrics = {
		time_improvement: [] as number[],
		tool_call_reduction: [] as number[],
		grep_elimination: [] as number[],
		files_read_reduction: [] as number[]
	};

	for (const result of results) {
		const { without_osgrep: without, with_osgrep: with_ } = result;
		
		metrics.time_improvement.push(without.duration_ms / with_.duration_ms);
		metrics.tool_call_reduction.push(((without.tool_calls - with_.tool_calls) / without.tool_calls) * 100);
		metrics.grep_elimination.push(without.grep_calls > 0 ? 100 : 0);
		metrics.files_read_reduction.push(((without.files_read - with_.files_read) / without.files_read) * 100);
	}

	return {
		avg_time_improvement: metrics.time_improvement.reduce((a, b) => a + b, 0) / metrics.time_improvement.length,
		avg_tool_call_reduction: metrics.tool_call_reduction.reduce((a, b) => a + b, 0) / metrics.tool_call_reduction.length,
		avg_grep_elimination: metrics.grep_elimination.reduce((a, b) => a + b, 0) / metrics.grep_elimination.length,
		avg_files_read_reduction: metrics.files_read_reduction.reduce((a, b) => a + b, 0) / metrics.files_read_reduction.length,
		total_benchmarks: results.length
	};
}

/**
 * Generate markdown table from results
 */
function generateMarkdownTable(results: BenchmarkComparison[]): string {
	let table = `| Repository | Question | Tool Calls (w/o) | Tool Calls (w/) | Improvement |\n`;
	table += `|------------|----------|------------------|-----------------|-------------|\n`;

	for (const result of results) {
		const { without_osgrep: without, with_osgrep: with_ } = result;
		const improvement = ((without.tool_calls - with_.tool_calls) / without.tool_calls * 100).toFixed(0);
		const shortQuestion = result.question.slice(0, 50) + (result.question.length > 50 ? '...' : '');
		
		table += `| ${result.repository_name} | ${shortQuestion} | ${without.tool_calls} | ${with_.tool_calls} | ${improvement}% |\n`;
	}

	return table;
}

/**
 * Generate visualization markdown
 */
function generateVisualization(results: BenchmarkComparison[]): string {
	const averages = calculateAverages(results);
	
	let md = `## 🎯 Agent Benchmark Results\n\n`;
	md += `*Comparing Claude Agent SDK performance with and without osgrep*\n\n`;
	
	md += `### Summary (${averages.total_benchmarks} benchmark${averages.total_benchmarks > 1 ? 's' : ''})\n\n`;
	
	// Calculate average metrics for visualization
	let avgTimeWithout = 0;
	let avgTimeWith = 0;
	let avgCostWithout = 0;
	let avgCostWith = 0;
	let avgToolCallsWithout = 0;
	let avgToolCallsWith = 0;
	
	for (const result of results) {
		avgTimeWithout += result.without_osgrep.duration_ms;
		avgTimeWith += result.with_osgrep.duration_ms;
		avgCostWithout += result.without_osgrep.cost_usd;
		avgCostWith += result.with_osgrep.cost_usd;
		avgToolCallsWithout += result.without_osgrep.tool_calls;
		avgToolCallsWith += result.with_osgrep.tool_calls;
	}
	
	avgTimeWithout /= results.length;
	avgTimeWith /= results.length;
	avgCostWithout /= results.length;
	avgCostWith /= results.length;
	avgToolCallsWithout /= results.length;
	avgToolCallsWith /= results.length;
	
	// Beautiful orange & black bar chart comparison
	md += `### 🎨 Performance Comparison\n\n`;
	md += `\`\`\`\n`;
	md += `⚡ Speed (seconds)\n`;
	const maxTime = Math.max(avgTimeWithout, avgTimeWith) / 1000;
	md += createBarChart('WITHOUT osgrep', avgTimeWithout / 1000, maxTime, 40, false); // Black
	md += `\n`;
	md += createBarChart('WITH osgrep   ', avgTimeWith / 1000, maxTime, 40, true); // Orange
	md += `\n\n`;
	
	md += `💰 Cost (USD)\n`;
	const maxCost = Math.max(avgCostWithout, avgCostWith);
	md += createBarChart('WITHOUT osgrep', avgCostWithout, maxCost, 40, false); // Black
	md += `\n`;
	md += createBarChart('WITH osgrep   ', avgCostWith, maxCost, 40, true); // Orange
	md += `\n\n`;
	
	md += `🔧 Tool Calls\n`;
	const maxTools = Math.max(avgToolCallsWithout, avgToolCallsWith);
	md += createBarChart('WITHOUT osgrep', avgToolCallsWithout, maxTools, 40, false); // Black
	md += `\n`;
	md += createBarChart('WITH osgrep   ', avgToolCallsWith, maxTools, 40, true); // Orange
	md += `\n`;
	md += `\`\`\`\n\n`;
	
	// Key metrics table
	md += `### 📊 Key Improvements\n\n`;
	md += `| Metric | Improvement |\n`;
	md += `|--------|-------------|\n`;
	md += `| **Tool Calls** | ${averages.avg_tool_call_reduction.toFixed(0)}% fewer |\n`;
	md += `| **Grep Searches** | ${averages.avg_grep_elimination.toFixed(0)}% eliminated |\n`;
	md += `| **Files Read** | ${averages.avg_files_read_reduction.toFixed(0)}% fewer |\n`;
	md += `| **Search Strategy** | Semantic vs. keyword-based |\n\n`;

	// Detailed results table
	md += `### Detailed Results\n\n`;
	md += generateMarkdownTable(results);
	md += `\n`;
	
	// Explanation
	md += `### How This Works\n\n`;
	md += `The benchmark uses the [Claude Agent SDK](https://github.com/anthropics/claude-agent-sdk-typescript) to compare two scenarios:\n\n`;
	md += `1. **Without osgrep**: Claude uses only \`Read\`, \`Grep\`, and \`Glob\` tools\n`;
	md += `   - Must search by keywords and file patterns\n`;
	md += `   - Requires multiple grep attempts to find relevant code\n`;
	md += `   - Often reads irrelevant files\n\n`;
	md += `2. **With osgrep**: Claude has access to the osgrep skill\n`;
	md += `   - Searches by semantic meaning: "how does authentication work?"\n`;
	md += `   - Finds relevant code immediately\n`;
	md += `   - Reads only the files that matter\n\n`;
	
	md += `**Repository Setup**: Benchmarks run on real open-source projects (requests, fastapi, flask) that are pre-indexed with osgrep.\n\n`;
	md += `**Question Types**: Deep codebase questions that require understanding architecture, not just finding keywords.\n\n`;
	
	md += `---\n\n`;
	md += `*Benchmarks run with Claude Sonnet 4.5 via the Agent SDK. Results may vary based on repository size and question complexity.*\n\n`;

	return md;
}

/**
 * Update README with benchmark section
 */
function updateReadme(visualizationMd: string, readmePath: string): void {
	let readme = readFileSync(readmePath, 'utf-8');
	
	// Remove old benchmark section if it exists
	const startMarker = '## 🎯 Agent Benchmark Results';
	const endMarker = '*Benchmarks run with Claude';
	
	if (readme.includes(startMarker)) {
		const startIdx = readme.indexOf(startMarker);
		const endIdx = readme.indexOf(endMarker, startIdx);
		if (endIdx !== -1) {
			// Find the end of the line with the end marker
			const lineEndIdx = readme.indexOf('\n', endIdx + endMarker.length);
			readme = readme.slice(0, startIdx) + readme.slice(lineEndIdx + 1);
		}
	}
	
	// Find insertion point (after "Coding Agent Integration" section or at the end of main content)
	const insertionPoint = readme.indexOf('## Commands');
	
	if (insertionPoint !== -1) {
		readme = readme.slice(0, insertionPoint) + visualizationMd + '\n' + readme.slice(insertionPoint);
	} else {
		// Fallback: append before license section
		const licenseIdx = readme.indexOf('## License');
		if (licenseIdx !== -1) {
			readme = readme.slice(0, licenseIdx) + visualizationMd + '\n' + readme.slice(licenseIdx);
		} else {
			// Last resort: append at end
			readme += '\n\n' + visualizationMd;
		}
	}
	
	writeFileSync(readmePath, readme, 'utf-8');
}

/**
 * Main execution
 */
function main() {
	const resultsFile = process.argv[2] || 'benchmark-results.json';
	const readmePath = process.argv[3] || join(__dirname, '../README.md');
	
	console.log(chalk.blue('📊 Generating benchmark visualization...\n'));
	
	// Read results
	let results: BenchmarkComparison[];
	try {
		const data = readFileSync(resultsFile, 'utf-8');
		results = JSON.parse(data);
		console.log(chalk.green(`✓ Loaded ${results.length} benchmark result(s) from ${resultsFile}`));
	} catch (error) {
		console.error(chalk.red(`✗ Failed to read ${resultsFile}:`), error);
		process.exit(1);
	}
	
	if (results.length === 0) {
		console.error(chalk.red('✗ No benchmark results found'));
		process.exit(1);
	}
	
	// Generate visualization
	const visualization = generateVisualization(results);
	
	// Update README
	try {
		updateReadme(visualization, readmePath);
		console.log(chalk.green(`✓ Updated ${readmePath} with benchmark results`));
	} catch (error) {
		console.error(chalk.red('✗ Failed to update README:'), error);
		process.exit(1);
	}
	
	// Display preview
	console.log(chalk.dim('\n─────────────────────────────────────────────'));
	console.log(visualization);
	console.log(chalk.dim('─────────────────────────────────────────────\n'));
	
	console.log(chalk.green('✓ Done!'));
}

if (require.main === module) {
	main();
}

export { generateVisualization, calculateAverages, generateMarkdownTable };

