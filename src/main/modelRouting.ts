/**
 * Which model each purpose runs on — FlexAgent's routing table.
 *
 * PI has no notion of a per-purpose model, so this policy is ours, kept beside
 * the rest of the app's own state at `~/.flexagent/routing.json`. It holds
 * **only** a role → `provider/id` mapping; turning that into a usable kernel
 * model needs the `ModelRuntime`, which lives in the worker. That split is
 * deliberate: a binding the kernel cannot resolve is reported back as an error
 * rather than quietly swapped for something else.
 *
 *   { "roles": { "chat":       { "provider": "ustc", "id": "qwen3-chat" },
 *                "compaction": { "provider": "ustc", "id": "qwen3-long" } } }
 *
 * `chat` unbound means the kernel's own default decides; every other role
 * unbound means it follows `chat`.
 */
import { homedir } from 'os'
import { join } from 'path'
import { ContractError, MODEL_ROLES } from '../shared/contract'
import type { ModelOption, ModelRole } from '../shared/contract'
import { asString, isRecord, deleteJsonDocument, readJsonDocument, writeJsonDocument } from './jsonFile'

export const ROUTING_FILE = join(homedir(), '.flexagent', 'routing.json')

const PROVIDER_RE = /^[a-zA-Z0-9_-]{1,64}$/
const MAX_ID_LENGTH = 200

export type RoleBindings = Partial<Record<ModelRole, ModelOption>>

export interface RoleBindingsRead {
  bindings: RoleBindings
  /**
   * One entry per malformed binding found in the file. The file is left as-is —
   * a hand-edited line is the user's, and silently dropping it would look like
   * the binding was never saved.
   */
  errors: Partial<Record<ModelRole, string>>
}

function isRole(value: unknown): value is ModelRole {
  return typeof value === 'string' && (MODEL_ROLES as readonly string[]).includes(value)
}

/** Read one stored `{ provider, id, label? }`; `undefined` when it is unusable. */
function parseBinding(value: unknown): ModelOption | string {
  if (value === null) return 'binding is null'
  if (!isRecord(value)) return 'binding must be an object'
  const provider = value.provider
  if (typeof provider !== 'string' || !PROVIDER_RE.test(provider)) {
    return 'provider must match [a-zA-Z0-9_-]{1,64}'
  }
  const id = asString(typeof value.id === 'string' ? value.id.trim() : undefined)
  if (id === undefined) return 'id is required'
  if (id.length > MAX_ID_LENGTH) return `id must be at most ${MAX_ID_LENGTH} characters`
  const label = asString(value.label)
  return { provider, id, ...(label !== undefined ? { label } : {}) }
}

export function readRoleBindings(file: string = ROUTING_FILE): RoleBindingsRead {
  const bindings: RoleBindings = {}
  const errors: Partial<Record<ModelRole, string>> = {}
  const document = readJsonDocument(file, 'routing.json')
  const declared = document.root.roles
  if (declared === undefined) return { bindings, errors }
  if (!isRecord(declared)) {
    for (const role of MODEL_ROLES) errors[role] = '"roles" must be an object'
    return { bindings, errors }
  }
  for (const [key, value] of Object.entries(declared)) {
    if (!isRole(key)) {
      // An unknown role cannot be reported per-role; keep it in the file but say
      // so through the only channel the UI has — the roles it does render.
      continue
    }
    const parsed = parseBinding(value)
    if (typeof parsed === 'string') errors[key] = parsed
    else bindings[key] = parsed
  }
  return { bindings, errors }
}

/**
 * Bind a role, or clear it with `null`.
 *
 * Only the touched role changes; every other binding, and every unknown key in
 * the file, is written back untouched. Clearing the *last* binding removes the
 * file instead of leaving an empty `roles` stub — an empty table and no table
 * mean the same thing, and only one of them looks like state.
 */
export async function writeRoleBinding(
  role: ModelRole,
  model: ModelOption | null,
  file: string = ROUTING_FILE
): Promise<void> {
  if (!isRole(role)) throw new ContractError('INVALID_INPUT', `Unknown model role: ${String(role)}`)
  const document = readJsonDocument(file, 'routing.json')
  if (!isRecord(document.root.roles)) document.root.roles = {}
  const roles = document.root.roles as Record<string, unknown>
  if (model === null) {
    delete roles[role]
    const others = Object.keys(document.root).filter((key) => key !== 'roles')
    if (Object.keys(roles).length === 0 && others.length === 0) {
      await deleteJsonDocument(document, 'routing.json')
      return
    }
  } else {
    const parsed = parseBinding(model)
    if (typeof parsed === 'string') throw new ContractError('INVALID_INPUT', parsed)
    roles[role] = parsed
  }
  await writeJsonDocument(document, 'routing.json')
}
