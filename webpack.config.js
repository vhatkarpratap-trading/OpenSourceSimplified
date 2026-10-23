const path = require('path');
const fs = require('fs');
const webpack = require('webpack');

class RendererHtmlPlugin {
  apply(compiler) {
    compiler.hooks.thisCompilation.tap('RendererHtmlPlugin', (compilation) => {
      compilation.hooks.processAssets.tap(
        {
          name: 'RendererHtmlPlugin',
          stage: webpack.Compilation.PROCESS_ASSETS_STAGE_ADDITIONAL,
        },
        () => {
          const templatePath = path.resolve(
            __dirname,
            'src/renderer/index.html',
          );

          const template = fs.readFileSync(templatePath, 'utf8');

          compilation.emitAsset(
            'index.html',
            new webpack.sources.RawSource(template),
          );
        },
      );
    });
  }
}

module.exports = {
  mode: 'development',
  target: 'web',
  entry: './src/renderer/index.tsx',
  devtool: 'source-map',

  module: {
    rules: [
      {
        test: /\.tsx?$/,
        exclude: /node_modules/,
        use: 'ts-loader',
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
      fs: false,
      path: false,
      os: false,
      crypto: false,
      child_process: false,
    },
  },

  plugins: [
    new RendererHtmlPlugin(),
    new webpack.DefinePlugin({
      'process.env': JSON.stringify({
        NODE_ENV: 'development',
        IS_PREACT: 'false',
      }),
    }),
  ],

  output: {
    filename: 'bundle.js',
    path: path.resolve(__dirname, 'dist/renderer'),
    clean: true,
  },
};
