module.exports = {
  'env': {
    'commonjs': true,
    'es2021': true,
    'node': true,
  },
  'extends': [
    'eslint:recommended',
  ],
  'parserOptions': {
    'ecmaVersion': 12,
  },
  'rules': {
    'max-len': ['warn', 140],
    'no-useless-escape': 'off',
    'no-unused-vars': ['warn', {
      'args': 'none'
    }]
  },
};
