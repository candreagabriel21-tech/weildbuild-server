// ═══════════════════════════════════════════════════════════
// WeildBuild — SIMPLE MODE (the declutter switch)
// ═══════════════════════════════════════════════════════════
// "this game is a little too complicated" — one switch that HIDES
// the features we're shelving for now. Nothing is deleted from the
// codebase: every hidden surface still exists, so flipping this
// back to false brings everything back exactly as it was.
//
// While true, the app hides:
//   • the Vote, Inventory and Shop entries in the sidebar and the
//     mobile bottom nav
//   • the WeBuy currency displays (top-bar chip, sidebar wallet,
//     profile stat card)
//   • the Badges card on the profile page
//   • the Chat tab inside the Friends page
//
// It does NOT touch gameplay: deaths, respawns, late-join state
// sync, server delta updates, interest management, duplicate-join
// kicks, HP bars and visibility settings all keep working exactly
// as before. The shop's item card view was moved INTO the avatar
// editor (same view, click to wear) so clothes can still be picked
// even though the shop itself is hidden.
export const SIMPLE_MODE = true;
