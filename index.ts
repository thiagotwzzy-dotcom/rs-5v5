import HaxballJS from "haxball.js";
import { addToGame, duringDraft, handlePlayerLeaveOrAFK } from "./src/chooser";
import { isCommand, handleCommand } from "./src/command";
import { playerMessage, sendMessage } from "./src/message";
import {
  handleBallOutOfBounds,
  handleBallInPlay,
  clearThrowInBlocks,
} from "./src/out";
import { rotateBall } from "./src/rotateBall";
import * as fs from "fs";
import { applySlowdown } from "./src/slowdown";
import initChooser from "./src/chooser";
import { welcomePlayer } from "./src/welcome";
import { applyRotation } from "./src/rotateBall";
import { afk } from "./src/afk";
import { initPlayer } from "./src/welcome";
import { applyMatchup } from "./src/matches";
import * as crypto from "node:crypto";
import config from "./config";

export const version = '1.0.0'

export interface lastTouch {
  byPlayer: PlayerAugmented;
  x: number;
  y: number;
}

export interface previousTouch {
  byPlayer: PlayerAugmented;
  x: number;
  y: number;
}
export interface holdPlayer {
  // used to save player data in memory for each game to handle him
  // returning to game and stats
  id: number;
  auth: string;
  team: TeamID;
}

export class PlayerAugmented {
  id: number;
  name: string;
  auth: string; // so that it doesn't disappear
  conn: string;
  team: 0 | 1 | 2;
  slowdown: number;
  slowdownUntil: number;
  afk: boolean;
  afkCounter: number;
  constructor(p: PlayerObject & Partial<PlayerAugmented>) {
    this.id = p.id;
    this.name = p.name;
    this.auth = p.auth;
    this.conn = p.conn;
    this.team = p.team;
    this.slowdown = p.slowdown || 0;
    this.slowdownUntil = p.slowdownUntil || 0;
    this.afk = false;
    this.afkCounter = 0;
  }
  get position() {
    return room.getPlayer(this.id).position;
  }
}

let gameId = 0;
export class Game {
  id: number;
  inPlay: boolean;
  animation: boolean;
  eventCounter: number;
  lastTouch: lastTouch | null;
  previousTouch: previousTouch | null;
  ballRotation: { x: number; y: number; power: number };
  positionsDuringPass: PlayerObject[];
  holdPlayers: holdPlayer[];
  rotateNextKick: boolean;

  constructor() {
    gameId += 1;
    this.id = gameId;
    this.eventCounter = 0; // to debounce some events
    this.inPlay = true;
    this.lastTouch = null;
    this.previousTouch = null;
    this.animation = false;
    this.ballRotation = { x: 0, y: 0, power: 0 };
    this.positionsDuringPass = [];
    this.holdPlayers = JSON.parse(JSON.stringify(players.map(p => { return { id: p.id, auth: p.auth, team: p.team }})))
    this.rotateNextKick = false;
  }
  rotateBall() {
    rotateBall(this);
  }
  handleBallTouch() {
    const ball = room.getDiscProperties(0);
    if (!ball) return;
    for (const p of room.getPlayerList()) {
      const prop = room.getPlayerDiscProperties(p.id);
      if (!prop) continue;
      const dist = Math.sqrt((prop.x - ball.x) ** 2 + (prop.y - ball.y) ** 2);
      const isTouching = dist < prop.radius + ball.radius + 0.1;
      if (isTouching) {
        this.recordBallTouch(toAug(p));
      }
    }
  }
  recordBallTouch(p: PlayerAugmented) {
    const ballPos = room.getBallPosition();
    if (!this.lastTouch || p.id !== this.lastTouch.byPlayer.id) {
      this.previousTouch = this.lastTouch;
      this.lastTouch = { byPlayer: p, x: ballPos.x, y: ballPos.y };
    }
  }

  handleBallOutOfBounds() {
    handleBallOutOfBounds(this);
  }
  handleBallInPlay() {
    handleBallInPlay(this);
  }
  applySlowdown() {
    applySlowdown();
  }
}

export let players: PlayerAugmented[] = [];
export let toAug = (p: PlayerObject) => {
  const found = players.find((pp) => pp.id == p.id);
  if (!found) {
    throw(`Lookup for player with id ${p.id} failed. Player is not in the players array: ${JSON.stringify(players)}`);
  }
  return found;
};
export let room: RoomObject;
export let game: Game | null;
export let adminPass: string = crypto.randomBytes(6).toString("hex");

const roomBuilder = async () => {
  const HBInit = await HaxballJS()
  const args: RoomConfigObject = { ...config, noPlayer: true }
  room = HBInit(args);
  const rsStadium = fs.readFileSync("./maps/rs5.hbs", {
    encoding: "utf8",
    flag: "r",
  });
  room.setCustomStadium(rsStadium);
  room.setTimeLimit(5);
  room.setScoreLimit(3);
  room.setTeamsLock(true);
  if (process.env.DEBUG) {
    room.setScoreLimit(1);
    room.setTimeLimit(1);
  }
  room.startGame();

  let i = 0;
  
  room.onTeamGoal = (team) => {
    const scorer = game?.lastTouch?.byPlayer;
    if (!scorer) return;

    const scores = room.getScores();
    const elapsed = Math.max(0, Math.floor(scores?.time ?? 0));
    const minutes = Math.floor(elapsed / 60);
    const seconds = elapsed % 60;
    const matchTime = `${minutes}:${seconds.toString().padStart(2, "0")}`;

    const previous = game?.previousTouch?.byPlayer;

    // Normal goal: scorer touched the ball last and belongs to the team that scored.
    if (scorer.team === team) {
      let message = `GOOOL! 🟥 ${scores?.red ?? 0} - ${scores?.blue ?? 0} 🟦 ⏱️ ${matchTime} ⚽ ${scorer.name}`;
      if (previous && previous.id !== scorer.id && previous.team === scorer.team) {
        message += ` (asistencia: ${previous.name})`;
      }
      sendMessage(message);
    } else {
      // Own goal: the player who last touched the ball is credited with the own goal.
      let message = `que mogul que sos ${scorer.name}`;
      // For an own goal, an opposing player's previous touch is considered an assist.
      if (previous && previous.id !== scorer.id && previous.team === team) {
        message += ` (asistencia: ${previous.name})`;
      }
      sendMessage(message);
    }
  };

  room.onGameTick = () => {
    if (!game) {
      return;
    }
    try {
      i++;
      game.handleBallTouch();
      if (i > 6) {
        if (game.inPlay) {
          game.handleBallOutOfBounds();
          game.rotateBall();
        } else {
          game.handleBallInPlay();
        }
        game.applySlowdown();
        afk.onTick();
        i = 0;
      }
    } catch (e) {
      console.log("Error:", e);
    }
  };

  room.onPlayerActivity = (p) => {
    afk.onActivity(p);
  };

  room.onPlayerJoin = async (p) => {
    if (!p.auth) {
      room.kickPlayer(p.id, "Tu clave de autenticación no es válida. Cambiala desde haxball.com/playerauth", false);
      return
    }
    if (process.env.DEBUG) {
      room.setPlayerAdmin(p.id, true);
    } else {
      if (players.map((p) => p.auth).includes(p.auth)) {
        room.kickPlayer(p.id, "Ya estás dentro del servidor.", false);
        return
      }
    }
    welcomePlayer(room, p);
await initPlayer(p);
    addToGame(room, p);
  };

  room.onPlayerLeave = async (p) => {
    players = players.filter((pp) => p.id != pp.id);
    await handlePlayerLeaveOrAFK();
    if (players.filter((p) => !p.afk).length < 1) {
      if (game) {
        game.eventCounter += 1
      }
      room.stopGame();
      room.startGame();
    }
  };

  room.onPlayerChat = (p, msg) => {
    const pp = toAug(p);
    if (process.env.DEBUG) {
      if (msg == "a") {
        room.setPlayerDiscProperties(p.id, { x: -10 });
      }
    }
    if (msg == "!debug") {
      console.log(game);
      return false;
    }

    if (isCommand(msg)) {
      handleCommand(pp, msg);
      return false;
    }

    playerMessage(pp, msg);
    return false;
  };

  room.onGameStart = (_) => {
    if (!duringDraft) {
      applyMatchup(room);
    }
    players.forEach((p) => {
      p.slowdownUntil = 0;
      p.slowdown = 0;
      p.slowdownUntil = 0;
    });
    if (!duringDraft) {
      game = new Game();
    }
    clearThrowInBlocks();
};

  room.onPositionsReset = () => {
    clearThrowInBlocks();
    if (game) {
      game.animation = false;
      room.setDiscProperties(0, {
        xspeed: 0,
        yspeed: 0,
        xgravity: 0,
        ygravity: 0,
      }); // without this, there was one tick where the ball's gravity was applied, and the ball has moved after positions reset.
      game.ballRotation = { x: 0, y: 0, power: 0 };
    }
  };

  room.onGameStop = (_) => {
    if (game) {
      game = null;
    }
  };

  room.onPlayerTeamChange = (p) => {
    if (process.env.DEBUG) {
      //room.setPlayerDiscProperties(p.id, {x: -10, y: 0})
    }
    toAug(p).team = p.team;
  };

  room.onPlayerBallKick = (p) => {
    if (game) {
      const pp = toAug(p);
      applyRotation(game, p);
      game.recordBallTouch(pp);
    }
  };

  room.onRoomLink = (url) => {
    console.log(`Room link: ${url}`);
    console.log(`Admin Password: ${adminPass}`);
  };

  initChooser(room); // must be called at the end
};

roomBuilder()
