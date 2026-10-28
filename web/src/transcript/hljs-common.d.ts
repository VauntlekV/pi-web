// `highlight.js/lib/common` ships no type declaration (only the package root does).
declare module "highlight.js/lib/common" {
  import type { HLJSApi } from "highlight.js";
  const hljs: HLJSApi;
  export default hljs;
}
