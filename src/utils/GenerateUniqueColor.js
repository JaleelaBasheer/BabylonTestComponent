import * as BABYLON from "@babylonjs/core";

 // Add this helper function to generate unique colors
 export const generateUniqueColor = (index, totalMeshes) => {
    // Use HSL color space for better distribution
    const hue = (index / totalMeshes) * 360;
    const saturation = 0.7; // 70% saturation
    const lightness = 0.6; // 60% lightness

    // Convert HSL to RGB
    const h = hue / 360;
    const s = saturation;
    const l = lightness;

    let r, g, b;

    if (s === 0) {
      r = g = b = l;
    } else {
      const hue2rgb = (p, q, t) => {
        if (t < 0) t += 1;
        if (t > 1) t -= 1;
        if (t < 1 / 6) return p + (q - p) * 6 * t;
        if (t < 1 / 2) return q;
        if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
        return p;
      };

      const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
      const p = 2 * l - q;

      r = hue2rgb(p, q, h + 1 / 3);
      g = hue2rgb(p, q, h);
      b = hue2rgb(p, q, h - 1 / 3);
    }

    return new BABYLON.Color3(r, g, b);
  };