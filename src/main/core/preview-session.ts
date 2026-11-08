import path from 'node:path'
import { type AgentId, type SessionKey, type SessionPreview, sessionKey } from '../../shared/sessions'
import type { CoreContext } from './export'
import type { OpenedArchive } from './import'
import { isNotFound } from './paths'

/** Read-only. A session listed on this machine, read from its store. */
export async function previewStoredSession(context: CoreContext, agent: AgentId, id: string): Promise<SessionPreview> {
  const provider = context.providers[agent]
  const root = path.resolve(provider.storeRoot(context.env))
  const attempt = async (): Promise<SessionPreview> => {
    const file = await provider.findTranscript(root, id, context.env)
    if (!file) return { kind: 'unavailable', reason: 'This session is no longer on this machine.' }
    return (await provider.previewTranscript(file)).preview
  }
  // Codex compresses an idle rollout and decompresses it on the next write, so the file can move once mid-read.
  return attempt().catch((error) => (isNotFound(error) ? attempt() : Promise.reject(error)))
}

/** Read-only. A session in an open archive, read from its verified staged blob. */
export async function previewArchivedSession(context: CoreContext, opened: OpenedArchive, key: SessionKey): Promise<SessionPreview | null> {
  const session = opened.manifest.sessions.find((each) => sessionKey(each.agent, each.id) === key)
  if (!session) return null
  const provider = context.providers[session.agent]
  const transcripts = session.files.filter((file) => file.role === provider.transcriptRole)
  if (transcripts.length !== 1) return { kind: 'unavailable', reason: 'The archive holds no single transcript for this session.' }
  const [file] = transcripts
  return (await provider.previewTranscript({ absPath: path.join(opened.blobDir, file!.sha256), path: file!.path })).preview
}
