/// <reference types="vite/client" />
declare module "*.css";
/** True only for the dev server and VITE_ATLAS_TOUR=1 builds (vite.config.ts `define`). */
declare const __ATLAS_TOUR_BUILD__: boolean;
