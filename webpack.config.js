const path = require("path");
const CopyPlugin = require("copy-webpack-plugin");
const { DefinePlugin } = require("webpack");
const { version } = require("./package.json");

module.exports = (env, argv) => ({
  entry: { hub: "./src/hub/hub.tsx", form: "./src/form/form.tsx" },
  output: {
    path: path.resolve(__dirname, "dist"),
    filename: "[name].js",
    clean: true,
  },
  // Source maps only in dev; the VSIX should stay small.
  devtool: argv.mode === "development" ? "inline-source-map" : false,
  resolve: { extensions: [".ts", ".tsx", ".js"] },
  module: {
    rules: [
      { test: /\.tsx?$/, loader: "ts-loader", exclude: /node_modules/ },
      { test: /\.css$/, use: ["style-loader", "css-loader"] },
      // Subsetted Fluent icon fonts (~7 KB) are inlined into the bundle.
      { test: /\.woff2$/, type: "asset/inline" },
    ],
  },
  plugins: [
    // Telemetry is off unless SAFE_ADO_TELEMETRY_URL is set when building (and an admin opts in).
    new DefinePlugin({
      __SAFE_ADO_TELEMETRY_URL__: JSON.stringify(process.env.SAFE_ADO_TELEMETRY_URL || ""),
      __SAFE_ADO_VERSION__: JSON.stringify(version),
    }),
    new CopyPlugin({
      patterns: [
        { from: "src/hub/hub.html", to: "hub.html" },
        { from: "src/form/form.html", to: "form.html" },
      ],
    }),
  ],
  performance: { hints: false },
});
