import type { ProviderRegistry } from '../core/provider'
import { claudeCodeProvider } from './claude-code'

export const providers: ProviderRegistry = {
  'claude-code': claudeCodeProvider,
}
