import {
  type ProcessFileInput,
  type ProcessFileResult,
  type RerankDoc,
  WorkerOrchestrator,
} from "./orchestrator";

export type { ProcessFileInput, ProcessFileResult, RerankDoc };

const orchestrator = new WorkerOrchestrator();

export default async function processFile(
  input: ProcessFileInput,
  onProgress?: () => void,
): Promise<ProcessFileResult> {
  return orchestrator.processFile(input, onProgress);
}

export async function encodeQuery(input: { text: string }) {
  return orchestrator.encodeQuery(input.text);
}

export async function rerank(input: {
  query: number[][];
  docs: RerankDoc[];
  colbertDim: number;
}) {
  return orchestrator.rerank(input);
}
