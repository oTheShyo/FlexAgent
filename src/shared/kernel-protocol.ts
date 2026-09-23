import type {
  ContractErrorCode,
  KernelEvent,
  PromptDisposition,
  SessionId,
  ThinkingLevel,
  ToolCallId
} from './contract/index'

/**
 * Internal main ↔ worker protocol (NOT part of the renderer contract).
 * Renderer never sees these shapes — only KernelEvent via IPC.kernelEvent.
 */

/** Distributive strip of `seq` so the KernelEvent union stays discriminated. */
export type StripSeq<E> = E extends { seq: number } ? Omit<E, 'seq'> : E
export type WorkerKernelEvent = StripSeq<KernelEvent>

/** Distributive strip of `requestId` — plain Omit collapses the request union. */
export type StripRequestId<R> = R extends { requestId: string } ? Omit<R, 'requestId'> : R

export type WorkerRequest =
  | { requestId: string; type: 'listSessions' }
  | { requestId: string; type: 'createSession'; sessionId: SessionId; cwd: string; title?: string }
  | { requestId: string; type: 'openSession'; sessionId: SessionId; cwd: string; piSessionFile?: string }
  | { requestId: string; type: 'prompt'; sessionId: SessionId; text: string; disposition: PromptDisposition }
  | { requestId: string; type: 'abort'; sessionId: SessionId }
  | { requestId: string; type: 'respondPermission'; sessionId: SessionId; toolCallId: ToolCallId; decision: 'allowOnce' | 'allowSession' | 'deny' }
  | { requestId: string; type: 'disposeSession'; sessionId: SessionId }
  | { requestId: string; type: 'listModels' }
  | { requestId: string; type: 'getModelConfig'; sessionId: SessionId }
  | { requestId: string; type: 'setModel'; sessionId: SessionId; provider: string; id: string; thinkingLevel?: ThinkingLevel }
  | { requestId: string; type: 'setThinkingLevel'; sessionId: SessionId; level: ThinkingLevel }
  | { requestId: string; type: 'shutdown' }

export type WorkerRequestInput = StripRequestId<WorkerRequest>

export type WorkerResponse =
  | { requestId: string; type: 'ok'; result?: unknown }
  | { requestId: string; type: 'fail'; code: ContractErrorCode; message: string; details?: unknown }
  | { type: 'event'; sessionId: SessionId; event: WorkerKernelEvent }

export type MainToWorker = WorkerRequest
export type WorkerToMain = WorkerResponse
