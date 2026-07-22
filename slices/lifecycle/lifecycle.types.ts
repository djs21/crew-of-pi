/**
 * Lifecycle types — subagent lifecycle management.
 */

export interface LifecycleResult {
  success: boolean;
  subagentId?: string;
  status?: string;
  message: string;
}
