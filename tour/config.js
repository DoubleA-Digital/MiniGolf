/* ============================================================
   CONFIG — every number worth tuning lives here.
   World units are YARDS throughout; y is up, the hole runs toward -z.
   ============================================================ */

export const G = 10.73;                 // gravity, yd/s^2 (9.81 m/s^2)
export const BALL_R = 0.02333;          // radius of a 1.68 in ball
export const CUP_R = 0.059;             // radius of a 4.25 in cup
export const MPH = 0.4889;              // 1 mph in yd/s
export const FT = 1 / 3;                // a foot in yards

// Air. Drag and lift share the 0.5*rho*A/m factor (per yard of travel).
export const AIR_K = 0.01746;
export const CD = 0.225;
export const SPIN_DECAY = 20;           // seconds for spin to fall to 1/e

// carry   = yards at a pure 100% swing, calm air, flat ground
// launch  = launch angle in degrees, spin = backspin rpm
export const CLUBS = [
  { id:'D',  name:'Driver',     short:'DR', carry:268, launch:9.6, spin:2450, err:1.00 },
  { id:'3W', name:'3 Wood',     short:'3W', carry:243, launch:10.8, spin:3300, err:0.95 },
  { id:'5W', name:'5 Wood',     short:'5W', carry:224, launch:12.4, spin:4000, err:0.92 },
  { id:'4H', name:'4 Hybrid',   short:'4H', carry:208, launch:14.5, spin:4500, err:0.88 },
  { id:'5i', name:'5 Iron',     short:'5i', carry:194, launch:15.0, spin:5000, err:0.86 },
  { id:'6i', name:'6 Iron',     short:'6i', carry:182, launch:16.5, spin:5800, err:0.82 },
  { id:'7i', name:'7 Iron',     short:'7i', carry:170, launch:18.0, spin:6700, err:0.78 },
  { id:'8i', name:'8 Iron',     short:'8i', carry:157, launch:20.0, spin:7600, err:0.74 },
  { id:'9i', name:'9 Iron',     short:'9i', carry:144, launch:22.5, spin:8400, err:0.70 },
  { id:'PW', name:'Pitching Wedge', short:'PW', carry:131, launch:25.0, spin:9000, err:0.66 },
  { id:'GW', name:'Gap Wedge',  short:'GW', carry:114, launch:28.0, spin:9500, err:0.62 },
  { id:'SW', name:'Sand Wedge', short:'SW', carry:97,  launch:31.0, spin:9900, err:0.58 },
  { id:'LW', name:'Lob Wedge',  short:'LW', carry:80,  launch:35.0, spin:10200, err:0.55 },
  { id:'P',  name:'Putter',     short:'PT', carry:0,   launch:0,    spin:0,    err:0 }
];
export const PUTTER = CLUBS.length - 1;

// Short-game shots. maxCarry is how far the ghost ball can travel at the end
// of the hold; launch/spin define the shape.
export const SHOTS = {
  bump:  { name:'Bump & Run', key:'bump',  launch:18, spin:3300, maxCarry:20, err:0.7,
           desc:'Low, lands early and releases' },
  pitch: { name:'Pitch',      key:'pitch', launch:30, spin:6800, maxCarry:80, err:0.9,
           desc:'Mid height, one hop and checks' },
  flop:  { name:'Flop',       key:'flop',  launch:48, spin:8200, maxCarry:50, err:1.3,
           desc:'High and soft, stops quickly' },
  splash:{ name:'Splash',     key:'splash',launch:38, spin:3800, maxCarry:60, err:1.5,
           desc:'Blast it out of the sand' }
};

// How each surface treats a ball resting in it (full swing modifiers)
// power multiplies carry, spin multiplies backspin, err multiplies the miss.
export const LIES = {
  tee:     { name:'Tee',        power:1.00, spin:1.00, launch:0,  err:1.00, pct:'100%' },
  fairway: { name:'Fairway',    power:1.00, spin:1.00, launch:0,  err:1.00, pct:'100%' },
  fringe:  { name:'Fringe',     power:0.97, spin:0.90, launch:0,  err:1.00, pct:'95–100%' },
  green:   { name:'Green',      power:1.00, spin:1.00, launch:0,  err:1.00, pct:'100%' },
  rough:   { name:'Rough',      power:0.88, spin:0.55, launch:-1, err:1.30, pct:'85–90%' },
  deep:    { name:'Deep Rough', power:0.72, spin:0.35, launch:-2, err:1.70, pct:'65–75%' },
  bunker:  { name:'Bunker',     power:0.80, spin:0.60, launch:1,  err:1.55, pct:'75–85%' },
  waste:   { name:'Waste Area', power:0.88, spin:0.70, launch:0,  err:1.30, pct:'85–90%' },
  water:   { name:'Water',      power:0,    spin:0,    launch:0,  err:1,    pct:'—' },
  ob:      { name:'Out of Bounds', power:0, spin:0,    launch:0,  err:1,    pct:'—' }
};

// How each surface treats a ball landing on and rolling over it.
// roll = rolling resistance (fraction of g), e = restitution,
// fric = tangential speed lost per bounce, grip = how much backspin bites.
export const SURF = {
  tee:     { roll:0.20, e:0.30, fric:0.30, grip:0.60 },
  fairway: { roll:0.20, e:0.30, fric:0.30, grip:0.65 },
  fringe:  { roll:0.13, e:0.24, fric:0.32, grip:0.85 },
  green:   { roll:0.058,e:0.20, fric:0.45, grip:1.00 },
  rough:   { roll:0.45, e:0.15, fric:0.55, grip:0.25 },
  deep:    { roll:0.80, e:0.08, fric:0.72, grip:0.10 },
  bunker:  { roll:2.20, e:0.03, fric:0.90, grip:0.00 },
  waste:   { roll:0.90, e:0.08, fric:0.66, grip:0.10 },
  ob:      { roll:0.50, e:0.15, fric:0.55, grip:0.20 },
  water:   { roll:9.00, e:0.00, fric:1.00, grip:0.00 }
};

export const DIFFICULTY = {
  amateur: { name:'Amateur', meter:0.78, window:0.14, perfect:0.028, chipSpeed:0.80,
             puttPreview:0.45, rollPreview:1.0, puttErr:0.3,  gimme:0.5, wind:0.7,
             desc:'Slower meter, putt preview, gimmes inside 2 ft' },
  pro:     { name:'Pro',     meter:1.00, window:0.095, perfect:0.018, chipSpeed:1.00,
             puttPreview:0.18, rollPreview:0.25, puttErr:0.8, gimme:0,   wind:1.0,
             desc:'The real thing. Short putt preview' },
  tour:    { name:'Tour',    meter:1.25, window:0.07, perfect:0.012, chipSpeed:1.22,
             puttPreview:0,    rollPreview:0,    puttErr:1.2,  gimme:0,   wind:1.25,
             desc:'Fast meter, no aids, stronger wind' }
};

// Six courses with their own look and character. New ones go on the end:
// the menu's preview-hole seed comes from each course's position.
export const THEMES = {
  pines: {
    name:'Whispering Pines', tag:'PARKLAND', desc:'Tree-lined, lush and fair. Water guards a few greens.',
    sky:['#5ea8e6', '#cfe8f7'], fog:'#cfe3ee', sun:[0.55, 0.75, 0.35], sunColor:'#fff4e0', sunI:2.3,
    hemi:['#cfe9ff', '#3f6b2f', 1.05],
    fairway:'#5daa44', fairway2:'#69b84e', green:'#6cc552', green2:'#79d05f', fringe:'#5cb348',
    rough:'#3d8a32', deep:'#2f6d28', outer:'#2c6526', sand:'#ead9a6', water:'#2f6f87', waterTop:'#3f93b5',
    tee:'#61b14a', waste:null,
    fairW:[17, 22], rough1:[16, 22], deepW:[18, 26], amp:3.5, bump:0.35, elev:[-7, 7],
    trees:1.0, treeKinds:['oak', 'pine', 'pine', 'birch'], waterChance:0.5, bunkerMul:1.0,
    potBunkers:false, wind:[0, 12]
  },
  links: {
    name:'Saltmarsh Links', tag:'LINKS', desc:'Open, firm and windy. Golden fescue and deep pot bunkers.',
    sky:['#7d9fbb', '#dfe7ea'], fog:'#d6dee2', sun:[-0.45, 0.6, 0.4], sunColor:'#fffaf0', sunI:1.9,
    hemi:['#dde8f0', '#6d6b3e', 1.15],
    fairway:'#7fae4f', fairway2:'#89b858', green:'#79bf55', green2:'#84c95f', fringe:'#72b04d',
    rough:'#6f9a42', deep:'#a3a45a', outer:'#7f9a4e', sand:'#e3d2a0', water:'#3d6470', waterTop:'#55828f',
    tee:'#80b051', waste:null,
    fairW:[21, 28], rough1:[10, 15], deepW:[30, 42], amp:2.4, bump:0.9, elev:[-4, 4],
    trees:0.18, treeKinds:['gorse', 'gorse', 'gorse'], waterChance:0.12, bunkerMul:1.6,
    potBunkers:true, wind:[6, 20], sea:true, flag:'#e63b2e', marker:'#2c5fd6'
  },
  mesa: {
    name:'Red Mesa', tag:'DESERT', desc:'Target golf. Miss the grass and you are in the waste.',
    sky:['#3f86c9', '#f3d9b5'], fog:'#efd7b8', sun:[0.4, 0.5, -0.55], sunColor:'#ffe1b0', sunI:2.5,
    hemi:['#ffe9cc', '#8a5a3a', 0.95],
    fairway:'#5fa843', fairway2:'#6bb44c', green:'#68c04f', green2:'#75cb5a', fringe:'#5aa845',
    rough:'#6f9a3d', deep:'#c79b6b', outer:'#c08d5d', sand:'#efd9ab', water:'#2c6f86', waterTop:'#3b95b0',
    tee:'#5ea946', waste:'#d3a676',
    fairW:[15, 19], rough1:[5, 8], deepW:[28, 40], amp:5.5, bump:0.5, elev:[-10, 10],
    trees:0.5, treeKinds:['cactus', 'cactus', 'rock', 'palo'], waterChance:0.18, bunkerMul:0.7,
    potBunkers:false, wind:[3, 15], flag:'#ffffff', marker:'#d84a2a', cloud:'#fff3e6'
  },
  maple: {
    name:'Maple Hollow', tag:'AUTUMN', desc:'Rolling hills in peak fall colour. Creeks cut across the fairways.',
    sky:['#4f97da', '#e3eef5'], fog:'#e2e4dc', sun:[0.5, 0.55, 0.45], sunColor:'#ffe6c2', sunI:2.2,
    hemi:['#f3e6d0', '#5a5a2e', 1.05],
    fairway:'#63a641', fairway2:'#6fb24a', green:'#6cc24f', green2:'#78cc5b', fringe:'#5fae45',
    rough:'#5b8a33', deep:'#6c8435', outer:'#627a30', sand:'#e8d4a0', water:'#3b6878', waterTop:'#4f8ea3',
    tee:'#62ab45', waste:null,
    fairW:[16, 21], rough1:[12, 18], deepW:[18, 26], amp:4.5, bump:0.55, elev:[-9, 9],
    trees:0.9, treeKinds:['maple', 'maple', 'maple', 'pine', 'birch'], waterChance:0.22, bunkerMul:0.9,
    potBunkers:false, wind:[0, 10], creek:0.6, leaves:true,
    flag:'#e8562a', marker:'#8a2e1c', cloud:'#fff8ee'
  },
  cay: {
    name:'Coral Cay', tag:'TROPICAL', desc:'An island course on the open ocean. Palms, white sand and trade winds.',
    sky:['#2f9be0', '#d8f1f7'], fog:'#cfeaf0', sun:[-0.3, 0.8, 0.35], sunColor:'#fffbe8', sunI:2.6,
    hemi:['#dff6ff', '#5f8a4a', 1.1],
    fairway:'#5cb84a', fairway2:'#68c454', green:'#6ccc55', green2:'#79d662', fringe:'#5fbd4c',
    rough:'#4e9a3c', deep:'#4e9a3c', outer:'#e2d6b0', sand:'#f6efd9', water:'#1d8fa3', waterTop:'#34c0cc',
    tee:'#62bb4f', waste:'#e9dfbf',
    fairW:[17, 23], rough1:[7, 11], deepW:[24, 34], amp:2.2, bump:0.6, elev:[-3, 3],
    trees:0.55, treeKinds:['palm', 'palm', 'palm', 'rock'], waterChance:0.7, bunkerMul:1.25,
    potBunkers:false, wind:[7, 20], sea:true, seaColor:'#1f8fa6',
    flag:'#ff4f8b', marker:'#ff8a3d', rock:[0.1, 0.25, 0.75]
  },
  frost: {
    name:'Glacier Peaks', tag:'ALPINE', desc:'Huge elevation in the high mountains. Miss the short grass and you are in the snow.',
    sky:['#5a8fc4', '#e6eef5'], fog:'#dfe7ee', sun:[0.35, 0.6, -0.5], sunColor:'#f4f8ff', sunI:2.2,
    hemi:['#e8f2ff', '#6a7a80', 1.2],
    fairway:'#5c9e48', fairway2:'#67a951', green:'#68b856', green2:'#73c260', fringe:'#5aa548',
    rough:'#4f8040', deep:'#e8eff4', outer:'#f2f6f9', sand:'#d9ccad', water:'#3d7f98', waterTop:'#7fb8cc',
    tee:'#5ea54b', waste:null,
    fairW:[15, 20], rough1:[8, 12], deepW:[22, 32], amp:6, bump:0.45, elev:[-15, 15],
    trees:0.75, treeKinds:['spruce', 'spruce', 'spruce', 'rock'], waterChance:0.3, bunkerMul:0.6,
    potBunkers:false, wind:[4, 16], snow:true, lieNames:{ deep:'Snow' }, lieColors:{ deep:'#eef4f8' },
    flag:'#1e6fff', marker:'#1e6fff', rock:[0.58, 0.06, 0.5], shadow:'rgba(70,90,130,0.36)'
  }
};

export const PARS_18 = [4, 4, 3, 5, 4, 4, 3, 4, 5,  4, 3, 4, 5, 4, 4, 3, 5, 4];

export const STROKE_CAP = 10;

export const SCORE_NAMES = { '-4':'Condor', '-3':'Albatross', '-2':'Eagle', '-1':'Birdie', '0':'Par',
                             '1':'Bogey', '2':'Double Bogey', '3':'Triple Bogey' };

export const PLAYER_COLORS = ['#ff5a4f', '#3d8bff', '#ffc531', '#b45cff'];
