export default {
  extends: ['@commitlint/config-conventional'],
  // Allow the repository bootstrap commit generated with the exact message
  // "Initial plan"; keep this bypass narrow and remove it once that workflow no
  // longer produces a non-conventional commit message.
  ignores: [(message) => message.trim() === 'Initial plan'],
};
