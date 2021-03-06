import { util } from "./util";
import { EventEmitter } from "eventemitter3";
import { Socket } from "./socket";
import { MediaConnection } from "./mediaconnection";
import { DataConnection } from "./dataconnection";
import {
  ConnectionType,
  PeerErrorType,
  PeerEventType,
  SocketEventType,
  SerializationType
} from "./enums";
import { BaseConnection } from "./baseconnection";
import { ServerMessage } from "./servermessage";
import { PeerConnectOption, PeerJSOption } from "..";
import { API } from "./api";

class PeerOptions implements PeerJSOption {
  debug: number; // 1: Errors, 2: Warnings, 3: All logs
  host: string;
  port: number;
  wsport: number;
  path: string;
  key: string;
  token: string;
  config: any;
  secure: boolean;
  logFunction: any;
}

/**
 * A peer who can initiate connections with other peers.
 */
export class Peer extends EventEmitter {
  private static readonly DEFAULT_KEY = "peerjs";

  private readonly _options: PeerOptions;
  private _id: string;
  private _lastServerId: string;
  private _api: API;

  // States.
  private _destroyed = false; // Connections have been killed
  private _disconnected = false; // Connection to PeerServer killed but P2P connections still active
  private _open = false; // Sockets and such are not yet open.
  private readonly _connections: Map<string, BaseConnection[]> = new Map(); // DataConnections for this peer.
  private readonly _lostMessages: Map<string, ServerMessage[]> = new Map(); // src => [list of messages]

  private _socket: Socket;

  get id() {
    return this._id;
  }

  get options() {
    return this._options;
  }

  get open() {
    return this._open;
  }

  get socket() {
    return this._socket;
  }

  get connections() {
    return this._connections;
  }

  get destroyed() {
    return this._destroyed;
  }
  get disconnected() {
    return this._disconnected;
  }

  constructor(id: any, options?: PeerOptions) {
    super();

    // Deal with overloading
    if (id && id.constructor == Object) {
      options = id;
      id = undefined;
    } else if (id) {
      // Ensure id is a string
      id = id.toString();
    }
    //

    // Configurize options
    options = {
      debug: 0, // 1: Errors, 2: Warnings, 3: All logs
      host: util.CLOUD_HOST,
      port: util.CLOUD_PORT,
      path: "/",
      key: Peer.DEFAULT_KEY,
      token: util.randomToken(),
      config: util.defaultConfig,
      ...options
    };
    this._options = options;

    // Detect relative URL host.
    if (options.host === "/") {
      options.host = window.location.hostname;
    }
    // Set path correctly.
    if (options.path[0] !== "/") {
      options.path = "/" + options.path;
    }
    if (options.path[options.path.length - 1] !== "/") {
      options.path += "/";
    }

    // Set whether we use SSL to same as current host
    if (options.secure === undefined && options.host !== util.CLOUD_HOST) {
      options.secure = util.isSecure();
    } else if (options.host == util.CLOUD_HOST) {
      options.secure = true;
    }
    // Set a custom log function if present
    if (options.logFunction) {
      util.setLogFunction(options.logFunction);
    }
    util.setLogLevel(String(options.debug));

    // Sanity checks
    // Ensure WebRTC supported
    if (!util.supports.audioVideo && !util.supports.data) {
      this._delayedAbort(
        PeerErrorType.BrowserIncompatible,
        "The current browser does not support WebRTC"
      );
      return;
    }
    // Ensure alphanumeric id
    if (!util.validateId(id)) {
      this._delayedAbort(PeerErrorType.InvalidID, `ID "${id}" is invalid`);
      return;
    }

    this._api = new API(options);

    // Start the server connection
    this._initializeServerConnection();

    if (id) {
      this._initialize(id);
    } else {
      this._api.retrieveId()
        .then(id => this._initialize(id))
        .catch(error => this._abort(PeerErrorType.ServerError, error));
    }
  }

  // Initialize the 'socket' (which is actually a mix of XHR streaming and
  // websockets.)
  private _initializeServerConnection(): void {
    this._socket = new Socket(
      this._options.secure,
      this._options.host,
      this._options.port,
      this._options.path,
      this._options.key,
      this._options.wsport
    );

    const self = this;

    this.socket.on(SocketEventType.Message, data => {
      self._handleMessage(data);
    });

    this.socket.on(SocketEventType.Error, error => {
      self._abort(PeerErrorType.SocketError, error);
    });

    this.socket.on(SocketEventType.Disconnected, () => {
      // If we haven't explicitly disconnected, emit error and disconnect.
      if (!self.disconnected) {
        self.emitError(PeerErrorType.Network, "Lost connection to server.");
        self.disconnect();
      }
    });

    this.socket.on(SocketEventType.Close, function () {
      // If we haven't explicitly disconnected, emit error.
      if (!self.disconnected) {
        self._abort(
          PeerErrorType.SocketClosed,
          "Underlying socket is already closed."
        );
      }
    });
  }

  /** Initialize a connection with the server. */
  private _initialize(id: string): void {
    this._id = id;
    this.socket.start(this.id, this._options.token);
  }

  /** Handles messages from the server. */
  private _handleMessage(message: ServerMessage): void {
    const type = message.type;
    const payload = message.payload;
    const peerId = message.src;

    switch (type) {
      case "OPEN": // The connection to the server is open.
        this.emit(PeerEventType.Open, this.id);
        this._open = true;
        break;
      case "ERROR": // Server error.
        this._abort(PeerErrorType.ServerError, payload.msg);
        break;
      case "ID-TAKEN": // The selected ID is taken.
        this._abort(PeerErrorType.UnavailableID, `ID "${this.id}" is taken`);
        break;
      case "INVALID-KEY": // The given API key cannot be found.
        this._abort(
          PeerErrorType.InvalidKey,
          `API KEY "${this._options.key}" is invalid`
        );
        break;

      //
      case "LEAVE": // Another peer has closed its connection to this peer.
        util.log("Received leave message from", peerId);
        this._cleanupPeer(peerId);
        break;

      case "EXPIRE": // The offer sent to a peer has expired without response.
        this.emitError(
          PeerErrorType.PeerUnavailable,
          "Could not connect to peer " + peerId
        );
        break;
      case "OFFER": {
        // we should consider switching this to CALL/CONNECT, but this is the least breaking option.
        const connectionId = payload.connectionId;
        let connection = this.getConnection(peerId, connectionId);

        if (connection) {
          connection.close();
          util.warn("Offer received for existing Connection ID:", connectionId);
        }

        // Create a new connection.
        if (payload.type === ConnectionType.Media) {
          connection = new MediaConnection(peerId, this, {
            connectionId: connectionId,
            _payload: payload,
            metadata: payload.metadata
          });
          this._addConnection(peerId, connection);
          this.emit(PeerEventType.Call, connection);
        } else if (payload.type === ConnectionType.Data) {
          connection = new DataConnection(peerId, this, {
            connectionId: connectionId,
            _payload: payload,
            metadata: payload.metadata,
            label: payload.label,
            serialization: payload.serialization,
            reliable: payload.reliable
          });
          this._addConnection(peerId, connection);
          this.emit(PeerEventType.Connection, connection);
        } else {
          util.warn("Received malformed connection type:", payload.type);
          return;
        }

        // Find messages.
        const messages = this._getMessages(connectionId);
        for (let message of messages) {
          connection.handleMessage(message);
        }

        break;
      }
      default: {
        if (!payload) {
          util.warn(
            `You received a malformed message from ${peerId} of type ${type}`
          );
          return;
        }

        const connectionId = payload.connectionId;
        const connection = this.getConnection(peerId, connectionId);

        if (connection && connection.peerConnection) {
          // Pass it on.
          connection.handleMessage(message);
        } else if (connectionId) {
          // Store for possible later use
          this._storeMessage(connectionId, message);
        } else {
          util.warn("You received an unrecognized message:", message);
        }
        break;
      }
    }
  }

  /** Stores messages without a set up connection, to be claimed later. */
  private _storeMessage(connectionId: string, message: ServerMessage): void {
    if (!this._lostMessages.has(connectionId)) {
      this._lostMessages.set(connectionId, []);
    }

    this._lostMessages.get(connectionId).push(message);
  }

  /** Retrieve messages from lost message store */
  private _getMessages(connectionId: string): ServerMessage[] {
    const messages = this._lostMessages.get(connectionId);

    if (messages) {
      this._lostMessages.delete(connectionId);
      return messages;
    }

    return [];
  }

  /**
   * Returns a DataConnection to the specified peer. See documentation for a
   * complete list of options.
   */
  connect(peer: string, options?: PeerConnectOption): DataConnection {
    if (this.disconnected) {
      util.warn(
        "You cannot connect to a new Peer because you called " +
        ".disconnect() on this Peer and ended your connection with the " +
        "server. You can create a new Peer to reconnect, or call reconnect " +
        "on this peer if you believe its ID to still be available."
      );
      this.emitError(
        PeerErrorType.Disconnected,
        "Cannot connect to new Peer after disconnecting from server."
      );
      return;
    }

    const connection = new DataConnection(peer, this, options);
    this._addConnection(peer, connection);
    return connection;
  }

  /**
   * Returns a MediaConnection to the specified peer. See documentation for a
   * complete list of options.
   */
  call(peer: string, stream: MediaStream, options: any = {}): MediaConnection {
    if (this.disconnected) {
      util.warn(
        "You cannot connect to a new Peer because you called " +
        ".disconnect() on this Peer and ended your connection with the " +
        "server. You can create a new Peer to reconnect."
      );
      this.emitError(
        PeerErrorType.Disconnected,
        "Cannot connect to new Peer after disconnecting from server."
      );
      return;
    }

    if (!stream) {
      util.error(
        "To call a peer, you must provide a stream from your browser's `getUserMedia`."
      );
      return;
    }

    options._stream = stream;

    const call = new MediaConnection(peer, this, options);
    this._addConnection(peer, call);
    return call;
  }

  /** Add a data/media connection to this peer. */
  private _addConnection(peerId: string, connection: BaseConnection): void {
    util.log(
      `add connection ${connection.type}:${connection.connectionId}
       to peerId:${peerId}`
    );

    if (!this.connections.has(peerId)) {
      this.connections.set(peerId, []);
    }
    this.connections.get(peerId).push(connection);
  }

  /** Retrieve a data/media connection for this peer. */
  getConnection(peerId: string, connectionId: string): null | BaseConnection {
    const connections = this.connections.get(peerId);
    if (!connections) {
      return null;
    }

    for (let connection of connections) {
      if (connection.connectionId === connectionId) {
        return connection;
      }
    }

    return null;
  }

  private _delayedAbort(type: PeerErrorType, message): void {
    const self = this;
    util.setZeroTimeout(function () {
      self._abort(type, message);
    });
  }

  /**
   * Destroys the Peer and emits an error message.
   * The Peer is not destroyed if it's in a disconnected state, in which case
   * it retains its disconnected state and its existing connections.
   */
  private _abort(type: PeerErrorType, message): void {
    util.error("Aborting!");

    if (!this._lastServerId) {
      this.destroy();
    } else {
      this.disconnect();
    }

    this.emitError(type, message);
  }

  /** Emits a typed error message. */
  emitError(type: PeerErrorType, err): void {
    util.error("Error:", err);

    if (typeof err === "string") {
      err = new Error(err);
    }

    err.type = type;

    this.emit(PeerEventType.Error, err);
  }

  /**
   * Destroys the Peer: closes all active connections as well as the connection
   *  to the server.
   * Warning: The peer can no longer create or accept connections after being
   *  destroyed.
   */
  destroy(): void {
    if (!this.destroyed) {
      this._cleanup();
      this.disconnect();
      this._destroyed = true;
    }
  }

  /** Disconnects every connection on this peer. */
  private _cleanup(): void {
    for (let peerId of this.connections.keys()) {
      this._cleanupPeer(peerId);
      this.connections.delete(peerId);
    }

    this.emit(PeerEventType.Close);
  }

  /** Closes all connections to this peer. */
  private _cleanupPeer(peerId: string): void {
    const connections = this.connections.get(peerId);

    if (!connections) return;

    for (let connection of connections) {
      connection.close();
    }
  }

  /**
   * Disconnects the Peer's connection to the PeerServer. Does not close any
   *  active connections.
   * Warning: The peer can no longer create or accept connections after being
   *  disconnected. It also cannot reconnect to the server.
   */
  disconnect(): void {
    const self = this;
    util.setZeroTimeout(function () {
      if (!self.disconnected) {
        self._disconnected = true;
        self._open = false;
        if (self.socket) {
          self.socket.close();
        }

        self.emit(PeerEventType.Disconnected, self.id);
        self._lastServerId = self.id;
        self._id = null;
      }
    });
  }

  /** Attempts to reconnect with the same ID. */
  reconnect(): void {
    if (this.disconnected && !this.destroyed) {
      util.log(
        "Attempting reconnection to server with ID " + this._lastServerId
      );
      this._disconnected = false;
      this._initializeServerConnection();
      this._initialize(this._lastServerId);
    } else if (this.destroyed) {
      throw new Error(
        "This peer cannot reconnect to the server. It has already been destroyed."
      );
    } else if (!this.disconnected && !this.open) {
      // Do nothing. We're still connecting the first time.
      util.error(
        "In a hurry? We're still trying to make the initial connection!"
      );
    } else {
      throw new Error(
        "Peer " +
        this.id +
        " cannot reconnect because it is not disconnected from the server!"
      );
    }
  }

  /**
   * Get a list of available peer IDs. If you're running your own server, you'll
   * want to set allow_discovery: true in the PeerServer options. If you're using
   * the cloud server, email team@peerjs.com to get the functionality enabled for
   * your key.
   */
  listAllPeers(cb = (arg: any[]) => { }): void {
    this._api.listAllPeers()
      .then(peers => cb(peers))
      .catch(error => this._abort(PeerErrorType.ServerError, error));
  }
}
