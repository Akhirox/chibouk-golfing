// Constantes partagées (unités : mètres, secondes)

export const TILE = 2.0;          // taille d'une case de parcours
export const BALL_R = 0.055;      // rayon de la balle (un peu agrandie pour la lisibilité)
export const CUP_R = 0.13;        // rayon du trou
export const WALL_H = 0.14;       // hauteur des bordures au-dessus du gazon
export const WALL_T = 0.12;       // épaisseur des bordures
export const GROUND_Y = 0;        // niveau du sol du décor

export const GRAVITY = 9.81;
export const ROLL_DECEL = 0.62;   // résistance au roulement sur moquette (m/s²)
export const SAND_DECEL = 4.2;    // dans le sable
export const LIN_DAMP = 0.16;     // amortissement proportionnel à la vitesse (1/s)
export const WALL_RESTITUTION = 0.68;
export const POST_RESTITUTION = 0.74;
export const GROUND_RESTITUTION = 0.32;
export const MAX_SPEED = 8.5;     // vitesse au coup de 100 %
export const POWER_EXP = 1.35;    // courbe de puissance (plus de précision sur les petits coups)

export const HOLES = 9;
export const MAX_STROKES = 10;    // limite de coups par trou
export const MAX_PLAYERS = 8;

export const DX = [1, 0, -1, 0];  // directions : 0 = +x, 1 = +z, 2 = -x, 3 = -z
export const DZ = [0, 1, 0, -1];

export const PEER_PREFIX = 'chibouk-golf-v1-';

export const BALL_COLORS = [
  '#ff7a1a', '#ffffff', '#ffd23f', '#e63946', '#3a86ff',
  '#2ec4b6', '#8338ec', '#ff5fa2', '#7ae582', '#1b1b1b',
];

export function powerToSpeed(p) {
  return MAX_SPEED * Math.pow(Math.max(0, Math.min(1, p)), POWER_EXP);
}
