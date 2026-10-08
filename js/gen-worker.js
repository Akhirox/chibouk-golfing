// Génération des trous en arrière-plan (évite de figer l'affichage)
import { generateHole } from './generator.js';

self.onmessage = (e) => {
  const { seed, count, job } = e.data;
  for (let k = 0; k < count; k++) {
    const def = generateHole(seed, k);
    self.postMessage({ job, index: k, def });
  }
};
