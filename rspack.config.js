module.exports = {
  mode: "production",
  target: "web",
  context: __dirname,
  entry: { app: "./src/app.ts" },
  resolve: { extensions: [".ts", ".tsx", ".js"] },
  module: {
    rules: [
      {
        test: /\.tsx?$/,
        use: {
          loader: "swc-loader",
          options: {
            jsc: {
              parser: { syntax: "typescript", tsx: true },
              // esnext is REQUIRED: builtin/downleveled targets turn `const` into `var`,
              // which disables the inline-const optimization and hides the bug.
              target: "esnext",
              transform: { react: { runtime: "classic" } },
            },
          },
        },
      },
    ],
  },
  optimization: {
    minimize: true,
    usedExports: true,
    sideEffects: true,
    concatenateModules: true, // scope hoisting must stay ON
    inlineExports: true,      // inline-const (new in 2.1) — required to trigger
    providedExports: true,
  },
  output: { path: __dirname + "/dist", filename: "[name].js" },
};
