export interface SkillInfo {
  name: string;
  description: string;
  whenToUse?: string;
  body: string;
  userInvocable: boolean;
}

export interface SkillFrontmatter {
  name?: string;
  description?: string;
  'when_to_use'?: string;
  'allowed-tools'?: unknown;
  'disallowed-tools'?: unknown;
  'disable-model-invocation'?: boolean;
  'user-invocable'?: boolean;
}
