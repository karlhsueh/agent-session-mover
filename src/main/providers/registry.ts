import type { ProviderRegistry } from '../core/provider'
import { claudeCodeProvider } from './claude-code'
import { codexProvider } from './codex'

export const providers: ProviderRegistry = {
  'claude-code': claudeCodeProvider,
  codex: codexProvider,
}
