export const SUPABASE_URL = "https://zbxcdiugunkyfvbxiecy.supabase.co";
export const SUPABASE_PUBLISHABLE_KEY = "sb_publishable_K-rsUdRw_4gEFx9uJxdbeQ_WBlC7WiZ";
export const EDGE_URL = `${SUPABASE_URL}/functions/v1/minisnap`;

export const DEFAULT_EVENT = {
  slug: "bgkv-studio",
  title: "MINISNAP PHOTOBOOTH",
  subtitle: "BGKV · STUDIO",
  footerText: "A SCHOOL MEMORY · KOLKATA",
  retentionHours: 24,
  autoUpload: true,
  openGuestAccess: true,
  waiverVersion: "v1.0-all-inclusive",
  waiverText:
    "By opting in, you grant BGKV and the event organizers a non-exclusive, royalty-free, worldwide license to include your captured photo strip and individual frames in an official commemorative event collage (digital or print). Your private QR delivery link remains strictly private and unshared with other guests. Unarchived sessions automatically expire and delete from storage after the configured retention window. You may request immediate deletion at any time using your session code.",
};

export const FILTERS = [
  { id: "none", label: "Studio Clean", badge: "Natural", desc: "Crisp skin & clarity" },
  { id: "paris", label: "Paris Glow", badge: "Snap Glow", desc: "Soft skin & halo" },
  { id: "golden", label: "Golden Hour", badge: "Sunlit", desc: "Amber warmth & flare" },
  { id: "y2k", label: "Y2K Digicam", badge: "Digicam", desc: "Flash pop & grain" },
  { id: "rio", label: "Rio Sunset", badge: "Snap Pop", desc: "Coral & teal grade" },
  { id: "prism", label: "Prism Dream", badge: "Prism", desc: "RGB split & leak" },
  { id: "noir", label: "Velvet Noir", badge: "Mono", desc: "High-contrast B&W" },
  { id: "cyber", label: "Neon Signal", badge: "AR Neon", desc: "Edge glow & HUD" },
];

export const THEMES = {
  pink: { id: "pink", label: "Blush", desc: "Soft rose", bg: "#f8e9e9", ink: "#493437", accent: "#c77f8d" },
  cream: { id: "cream", label: "Vanilla", desc: "Warm paper", bg: "#f2eadd", ink: "#504334", accent: "#b39468" },
  dark: { id: "dark", label: "Midnight", desc: "Matte dark", bg: "#201d22", ink: "#fff6f1", accent: "#d5a2ac" },
};

export const LAYOUTS = [
  { id: "strip-4", label: "1×4 Strip", desc: "Classic vertical" },
  { id: "grid-2x2", label: "2×2 Postcard", desc: "Print grid" },
  { id: "strip-3", label: "1×3 Wide", desc: "First 3 frames" },
];

export const POSE_PROMPTS = [
  "Classic smile — look into the lens",
  "Strike a pose — lean in close",
  "Candid laugh or peace sign",
  "Grand finale — make it memorable",
];
