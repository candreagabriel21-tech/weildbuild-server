// ═══════════════════════════════════════════════════════════════════
// WeLua — shared types + the API reference shown in the code editor
// ═══════════════════════════════════════════════════════════════════
// WeLua is WeildBuild's scripting language: real Lua plus a `welu` API
// that talks to the world (parts, players, inventory, effects, camera).
// Scripts are plain {id, name, code, enabled} records stored per part
// (StudioPart.weluScripts) and on the game (gameWeluScripts).

export interface WeluScript {
  id: string;
  name: string;
  code: string;
  enabled: boolean;
}

export function createWeluScript(name?: string): WeluScript {
  return {
    id: `welu_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`,
    name: name || 'Script',
    code: [
      '-- WeLua script (Lua)',
      '-- This runs when the game starts.',
      '',
      'welu.onStart(function()',
      '  welu.print("Hello from WeLua!")',
      'end)',
      '',
    ].join('\n'),
    enabled: true,
  };
}

// ─── API reference (rendered by the Code editor's WeLua tab) ───

export interface WeluApiEntry {
  signature: string;
  description: string;
  /** 'events' | 'parts' | 'player' | 'world' | 'items' | 'util' */
  group: 'events' | 'parts' | 'player' | 'world' | 'items' | 'util';
}

export const WELU_API_REFERENCE: WeluApiEntry[] = [
  // events
  { group: 'events', signature: 'welu.onStart(fn)', description: 'Run fn once when the game starts.' },
  { group: 'events', signature: 'welu.onTick(fn(dt))', description: 'Run fn every frame with the delta time (seconds).' },
  { group: 'events', signature: 'welu.onTimer(seconds, fn)', description: 'Run fn every N seconds (use welu.wait for one-off delays).' },
  { group: 'events', signature: 'welu.onClick(fn)', description: 'Part scripts: run fn when THIS part is clicked.' },
  { group: 'events', signature: 'welu.onTouch(fn(other, isPlayer))', description: 'Part scripts: run fn when a player or part touches this part.' },
  { group: 'events', signature: 'welu.onDestroy(fn)', description: 'Part scripts: run fn just before this part is destroyed.' },
  { group: 'events', signature: 'welu.onKey(key, fn)', description: 'Game scripts: run fn when a key is pressed (e.g. "e", "space").' },
  { group: 'events', signature: 'welu.onChat(fn(username, message))', description: 'Game scripts: run fn on every chat message.' },
  { group: 'events', signature: 'welu.onPlayerJoin(fn(username))', description: 'Game scripts: run fn when a player joins.' },
  { group: 'events', signature: 'welu.onPlayerLeave(fn(username))', description: 'Game scripts: run fn when a player leaves.' },
  { group: 'events', signature: 'welu.onPlayerDied(fn(username))', description: 'Game scripts: run fn when a player dies.' },
  { group: 'events', signature: 'welu.onPlayerDamaged(fn(username, amount, health))', description: 'Game scripts: run fn when a player takes damage.' },
  { group: 'events', signature: 'welu.onItemUsed(fn(itemName))', description: 'Run fn when a player uses an inventory item.' },
  { group: 'events', signature: 'welu.onItemEquipped(fn(itemName))', description: 'Run fn when an item is selected in the hotbar.' },
  { group: 'events', signature: 'welu.onItemUnequipped(fn(itemName))', description: 'Run fn when an item is deselected.' },
  { group: 'events', signature: 'welu.onGrabbed(fn(itemName))', description: 'Run fn when a part/group is grabbed into the inventory.' },
  { group: 'events', signature: 'welu.onDropped(fn(itemName))', description: 'Run fn when an item is placed back into the world.' },

  // parts
  { group: 'parts', signature: 'welu.this()', description: 'The part this script runs on (nil for game scripts).' },
  { group: 'parts', signature: 'welu.find(name)', description: 'The first part with that name, or nil.' },
  { group: 'parts', signature: 'welu.findAll(name)', description: 'Every part with that name, as a Lua table.' },
  { group: 'parts', signature: 'welu.allParts()', description: 'Every part in the world, as a Lua table.' },
  { group: 'parts', signature: 'welu.create({name=, type=, position=, size=, color=, ...})', description: 'Create a part. type: Block/Sphere/Wedge/Cylinder. Returns the new part.' },
  { group: 'parts', signature: 'part.name / .position / .size / .rotation', description: 'Read or WRITE the part\'s name, {x,y,z} position, size or {x,y,z} rotation in degrees.' },
  { group: 'parts', signature: 'part.color / .material / .transparency', description: 'Color ("#ff0000"), material ("Neon", "Wood", ...) or transparency (0-1).' },
  { group: 'parts', signature: 'part.anchored / .canCollide / .visible', description: 'Physics + visibility flags (true/false).' },
  { group: 'parts', signature: 'part:destroy()', description: 'Delete the part.' },
  { group: 'parts', signature: 'part:clone(offset)', description: 'Copy the part to an offset {x,y,z}; returns the copy.' },
  { group: 'parts', signature: 'part:applyForce(v) / part:applyImpulse(v)', description: 'Push the part with a continuous force / an instant impulse {x,y,z}.' },
  { group: 'parts', signature: 'part:catchFire() / part:extinguish()', description: 'Fire effect on/off.' },
  { group: 'parts', signature: 'part:light(color, brightness, range)', description: 'Attach a light effect (color, 0-10, 0-60).' },
  { group: 'parts', signature: 'part:disableLight() / part:smoke(color) / part:clearSmoke()', description: 'Remove light / add smoke / remove smoke.' },
  { group: 'parts', signature: 'part:weld(other)', description: 'Weld this part to another part.' },
  { group: 'parts', signature: 'part:breakJoints()', description: 'Remove all joints on this part.' },

  // player
  { group: 'player', signature: 'welu.player.name', description: 'The local player\'s username.' },
  { group: 'player', signature: 'welu.player.position', description: 'The player\'s {x,y,z} position (feet).' },
  { group: 'player', signature: 'welu.player.health / .maxHealth', description: 'Read or write the player\'s health.' },
  { group: 'player', signature: 'welu.player.speed', description: 'Read or write the walk speed (default 10.8).' },
  { group: 'player', signature: 'welu.player:teleport(v)', description: 'Teleport the player to {x,y,z}.' },
  { group: 'player', signature: 'welu.player:damage(n) / :heal(n) / :kill() / :respawn()', description: 'Change the player\'s health or respawn them.' },
  { group: 'player', signature: 'welu.player:giveItem(name) / :removeItem(name)', description: 'Add / remove an inventory item by name.' },

  // world
  { group: 'world', signature: 'welu.explode(v, radius, pressure)', description: 'Explosion at {x,y,z} (defaults: radius 4, pressure 500000).' },
  { group: 'world', signature: 'welu.gravity', description: 'Read or write world gravity (default -35).' },
  { group: 'world', signature: 'welu.timeOfDay', description: 'Read or write the clock (0-24 hours; 12 = noon).' },
  { group: 'world', signature: 'welu.weather', description: 'Read or write the weather: "clear", "cloudy", "rain", "snow".' },
  { group: 'world', signature: 'welu.camera.setPosition(v) / .setYaw(deg) / .setPitch(deg)', description: 'Cutscene camera: jump the camera to a position / yaw / pitch.' },
  { group: 'world', signature: 'welu.sound(name, volume)', description: 'Play a sound: click, pop, boom, whoosh, chime, alert.' },
  { group: 'world', signature: 'welu.message(text, duration, color)', description: 'Show a message on every player\'s screen.' },
  { group: 'world', signature: 'welu.getVar(name) / welu.setVar(name, value)', description: 'Global variables shared with block rules.' },

  // items
  { group: 'items', signature: 'welu.giveItem(name) / welu.removeItem(name)', description: 'Give the player an item from the project inventory.' },
  { group: 'items', signature: 'welu.dropItem(name)', description: 'Spawn an inventory item into the world in front of the player.' },
  { group: 'items', signature: 'welu.inventoryNames()', description: 'The names of everything in the player\'s inventory.' },

  // util
  { group: 'util', signature: 'welu.wait(seconds)', description: 'Pause this script (other scripts keep running). THE way to make delays.' },
  { group: 'util', signature: 'welu.time()', description: 'Seconds since the game started.' },
  { group: 'util', signature: 'welu.print(...)', description: 'Print to the studio Output panel (also: print(...)).' },
];

/** A ready-to-paste example shown in the editor's WeLua tab. */
export const WELU_EXAMPLES: Array<{ title: string; code: string }> = [
  {
    title: 'Disappearing bridge (onTouch + wait)',
    code: [
      '-- Put this on a part: it vanishes 1s after being stepped on,',
      '-- and comes back 5s later.',
      'welu.onTouch(function(other, isPlayer)',
      '  if not isPlayer then return end',
      '  local me = welu.this()',
      '  welu.sound("pop", 0.4)',
      '  me.visible = false',
      '  me.canCollide = false',
      '  welu.wait(5)',
      '  me.visible = true',
      '  me.canCollide = true',
      'end)',
    ].join('\n'),
  },
  {
    title: 'Gold pickup (giveItem + destroy)',
    code: [
      '-- Put this on a golden part: picking it up gives a point.',
      'welu.onTouch(function(other, isPlayer)',
      '  if not isPlayer then return end',
      '  local score = (welu.getVar("score") or 0) + 1',
      '  welu.setVar("score", score)',
      '  welu.message("Gold: " .. score, 2, "#ffd75e")',
      '  welu.sound("chime", 0.5)',
      '  welu.this():destroy()',
      'end)',
    ].join('\n'),
  },
  {
    title: 'Magic sword (when_used rules via WeLua)',
    code: [
      '-- Game script: using the "Sword" item swings the arm and',
      '-- launches whoever it hits (the when_used rules handle damage).',
      'welu.onItemUsed(function(itemName)',
      '  if itemName ~= "Sword" then return end',
      '  local hits = welu.findAll("Target")',
      '  for _, t in ipairs(hits) do',
      '    if t and t.visible ~= false then',
      '      t:applyImpulse({x = 0, y = 30, z = 0})',
      '    end',
      '  end',
      'end)',
    ].join('\n'),
  },
  {
    title: 'Day/night + weather controller',
    code: [
      '-- Game script: a slow day cycle and rain at dusk.',
      'welu.onStart(function()',
      '  welu.timeOfDay = 8',
      '  while true do',
      '    welu.wait(30)',
      '    local t = welu.timeOfDay + 0.5',
      '    if t >= 24 then t = 0 end',
      '    welu.timeOfDay = t',
      '    if t > 17 and t < 19 then welu.weather = "rain" end',
      '    if t > 6 and t < 8 then welu.weather = "clear" end',
      '  end',
      'end)',
    ].join('\n'),
  },
  {
    title: 'Tower of blocks (create + loops)',
    code: [
      '-- Game script: build a colorful tower at spawn.',
      'welu.onStart(function()',
      '  local colors = {"#ff4444", "#ffcc00", "#44dd44", "#4a90d9", "#aa66ff"}',
      '  for i = 1, 10 do',
      '    welu.create({',
      '      name = "TowerBlock" .. i,',
      '      type = "Block",',
      '      position = {x = 10, y = 0.5 + (i - 1) * 1, z = 0},',
      '      size = {x = 2, y = 1, z = 2},',
      '      color = colors[(i % #colors) + 1],',
      '      anchored = (i % 2 == 1),',
      '    })',
      '    welu.wait(0.1)',
      '  end',
      '  welu.message("Tower complete!", 3, "#7dff9b")',
      'end)',
    ].join('\n'),
  },
];
