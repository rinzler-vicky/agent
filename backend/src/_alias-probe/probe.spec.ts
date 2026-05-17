import { ALIAS_PROBE_OK } from '@/_alias-probe/probe';

describe('tsconfig path-alias plumbing', () => {
  it('resolves @/* imports via ts-jest moduleNameMapper', () => {
    expect(ALIAS_PROBE_OK).toBe('alias-resolved');
  });
});
