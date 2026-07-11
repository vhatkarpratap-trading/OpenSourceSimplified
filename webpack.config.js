const path = require('path');
const webpack = require('webpack');

module.exports = {
  mode: 'development',
  entry: './src/renderer/index.tsx',
  target: 'web',
  devtool: 'source-map',
  module: {
    rules: [
      {
        test: /\.tsx?$/,
        use: 'ts-loader',
        exclude: /node_modules/,
      },
      {
        test: /\.css$/,
        use: ['style-loader', 'css-loader'],
      },
    ],
  },
  resolve: {
    extensions: ['.tsx', '.ts', '.js'],
    fallback: {
      path: false,
      fs: false,
      os: false,
      crypto: false,
    },
  },
  plugins: [
    new webpack.DefinePlugin({
      'process.env.NODE_ENV': JSON.stringify('development'),
      'process.env': '{}',
      'process.platform': JSON.stringify('darwin'),
      'process.version': JSON.stringify(''),
    }),
  ],
  output: {
    filename: 'bundle.js',
    path: path.resolve(__dirname, 'dist/renderer'),
  },
  externals: {
    'node-pty': 'commonjs node-pty',
    '@typescript-eslint/typescript-estree': 'commonjs @typescript-eslint/typescript-estree',
    'glob': 'commonjs glob',
    'fs': 'commonjs fs',
    'child_process': 'commonjs child_process',
  },
};
