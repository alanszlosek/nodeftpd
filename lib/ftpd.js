var net = require('net');
var util = require('util');
var fs = require('fs');
var dummyfs = require('./dummyfs');
var PathModule = require('path');
var glob = require('./glob');
require('./date-format');

var internals = {
  socket: null,
  server: null
};

var _supportedCommands = [
  'CDUP',
  'CWD',
  'DELE',
  'FEAT',
  'LIST',
  'MKD',
  'NLST',
  'PASS',
  'PASV',
  'PORT',
  'PWD',
  'QUIT',
  'RETR',
  'RMD',
  'RNFR',
  'RNTO',
  'SIZE',
  'STOR',
  'SYST',
  'TYPE',
  'USER',
  'XPWD'
];

var _unsupportedCommands = [
  'ABOR', // unsupported
  'ACCT', // unsupported
  'ADAT', // unsupported
  'ALLO', // unsupported
  'APPE', // unsupported
  'AUTH', // unsupported
  'CCC', // unsupported
  'CONF', // unsupported
  'ENC', // unsupported
  'EPRT', // unsupported
  'EPSV', // unsupported
  'HELP', // unsupported
  'LANG', // unsupported
  'LPRT', // unsupported
  'LPSV', // unsupported
  'MDTM', // unsupported
  'MIC', // unsupported
  'MLSD', // unsupported
  'MLST', // unsupported
  'MODE', // unsupported
  'NOOP', // unsupported
  'OPTS', // unsupported
  'PBSZ', // unsupported
  'REIN', // unsupported
  'REST', // unsupported
  'SITE', // unsupported
  'SMNT', // unsupported
  'STAT', // unsupported
  'STOU', // unsupported
  'STRU' // unsupported
];


/*
TODO:
- Implement Full RFC 959
- Implement RFC 2428
- Implement RFC 2228
- Implement RFC 3659
- Implement TLS - http://en.wikipedia.org/wiki/FTPS

*/


/**
 * [logIf description]
 *
 * @param  {[type]} level
 * @param  {[type]} message
 * @param  {[type]} internals.socket
 *
 * @return {[type]}
 */
internals.logIf = function(level, message, socket) {
  if (internals.server.debugging >= level) {
    if (socket) {
      console.log(socket.remoteAddress + ': ' + message);
    } else {
      console.log(message);
    }
  }
};


/**
 * [authenticated description]
 *
 * @return {[type]}
 */
internals.authenticated = function() {
  // send a message if not authenticated?
  return (internals.socket.username ? true : false);
};


/**
 * [authFailures description]
 *
 * @return {[type]}
 */
internals.authFailures = function() {
  if (internals.socket.authFailures >= 2) {
    internals.socket.end();
    return true;
  }

  return false;
};


/**
 * [closeDataConnections description]
 *
 * @return {[type]}
 */
internals.closeDataConnections = function() {
  if (internals.socket.dataListener) {
    internals.socket.dataListener.close(); // we're creating a new listener
  }

  if (internals.socket.dataSocket) {
    internals.socket.dataSocket.end(); // close any existing connections
  }
};


/**
 * Purpose of this is to ensure a valid data connection, and run the callback when it's ready
 *
 * @param  {Function} callback
 *
 * @return {[type]}
 */
internals.whenDataWritable = function(callback) {
  if (internals.socket.passive) {
    // how many data connections are allowed?
    // should still be listening since we created a server, right?
    if (internals.socket.dataSocket) {
      internals.logIf(3, 'A data connection exists', internals.socket);

      if (callback) {
        callback(internals.socket.dataSocket); // do!
      }
    } else {
      internals.logIf(3, 'Passive, but no data internals.socket exists ... waiting', internals.socket);

      internals.socket.dataListener.on('data-ready', function(dataSocket) {
        internals.logIf(3, 'Looks like waiting paid off. Here we go!');
        callback(dataSocket);
      });

      //internals.socket.write("425 Can't open data connection\r\n");
    }
  } else {
    // Do we need to open the data connection?
    if (internals.socket.dataSocket) { // There really shouldn't be an existing connection
      internals.logIf(3, 'Using existing non-passive dataSocket', internals.socket);
      callback(internals.socket.dataSocket);
    } else {
      internals.logIf(1, 'Opening data connection to ' + internals.socket.dataHost + ':' + internals.socket.dataPort, internals.socket);

      var dataSocket = new net.Socket();

      // Since data may arrive once the connection is made, pause it right away
      dataSocket.on('data', function(data) {
        internals.logIf(3, dataSocket.remoteAddress + ' event: data ; ' + (Buffer.isBuffer(data) ? 'buffer' : 'string'));
      });

      dataSocket.addListener('connect', function() {
        dataSocket.pause(); // Pause until the data listeners are in place
        internals.socket.dataSocket = dataSocket;
        internals.logIf(3, 'Data connection succeeded', internals.socket);
        callback(dataSocket);
      });

      dataSocket.addListener('close', function(had_error) {
        internals.socket.dataSocket = null;
        if (had_error) {
          internals.logIf(0, 'Data event: close due to error', internals.socket);
        } else {
          internals.logIf(3, 'Data event: close', internals.socket);
        }
      });

      dataSocket.addListener('end', function() {
        internals.logIf(3, 'Data event: end', internals.socket);
      });

      dataSocket.addListener('error', function(err) {
        internals.logIf(0, 'Data event: error: ' + err, internals.socket);
        dataSocket.destroy();
      });

      dataSocket.connect(internals.socket.dataPort, internals.socket.dataHost);
    }
  }
};


/**
 * host should be an IP address, and sandbox a path without trailing slash for now
 *
 * @param  {[type]} host
 * @param  {[type]} sandbox
 *
 * @return {[type]}
 */
internals.createServer = function(host, sandbox) {
  // make sure host is an IP address, otherwise DATA connections will likely break
  internals.server = net.createServer();
  internals.server.baseSandbox = sandbox; // path which we're starting relative to
  internals.server.debugging = 0;

  internals.server.on('listening', function() {
    internals.logIf(0, 'nodeFTPd server up and ready for connections');
  });

  internals.server.on('connection', function(socket) {
    internals.socket = socket;

    internals.server.emit('client:connected', internals.socket); // pass internals.socket so they can listen for client-specific events

    internals.socket.setTimeout(0); // We want to handle timeouts ourselves
    internals.socket.setEncoding('ascii'); // force data String not Buffer, so can parse FTP commands as a string
    internals.socket.setNoDelay();

    internals.socket.passive = false;
    internals.socket.dataHost = null;
    internals.socket.dataPort = 20; // default
    internals.socket.dataListener = null; // for incoming passive connections
    internals.socket.dataSocket = null; // the actual data internals.socket
    internals.socket.mode = 'ascii';
    internals.socket.filefrom = '';
    // Authentication
    internals.socket.authFailures = 0; // 3 tries then we disconnect you
    internals.socket.username = null;

    internals.socket.sandbox = sandbox; // after authentication we'll tack on a user-specific subfolder
    internals.socket.fs = new dummyfs.dummyfs('/');
    internals.logIf(0, 'Base FTP directory: ' + internals.socket.fs.cwd());

    internals.socket.addListener('data', function(data) {
      data = (data + '').trim();
      internals.logIf(2, 'FTP command: ' + data, internals.socket);

      var command, commandArg;

      var index = data.indexOf(' ');
      if (index > 0) {
        command = data.substring(0, index).trim().toUpperCase();
        commandArg = data.substring(index + 1, data.length).trim();
      } else {
        command = data.trim().toUpperCase();
        commandArg = '';
      }
      // Separate authenticated versus not?

      //-----------------------------------
      // process commands here
      //-----------------------------------
      if (_supportedCommands.indexOf(command) === -1) {
        internals.logIf(0, command + ' is an unsupported command', internals.socket);
      } else {
        internals.command(command, commandArg);
      }
    });


    internals.socket.addListener('end', function() {
      internals.logIf(1, 'Client connection ended', internals.socket);
    });

    internals.socket.addListener('error', function(err) {
      internals.logIf(0, 'Client connection error: ' + err, internals.socket);
    });

    // Tell client we're ready
    internals.logIf(1, 'Connection', internals.socket);
    internals.socket.write('220 FTP server (nodeftpd) ready\r\n');
  });

  internals.server.addListener('close', function() {
    internals.logIf(0, 'Server closed');
  });

  return internals.server;
};

internals.command = function(command, commandArg) {
  switch (command) {
    case 'CDUP':
      // Change to Parent Directory.
      if (!internals.authenticated()) {
        break;
      }

      internals.socket.write('250 Directory changed to ' + internals.socket.fs.chdir('..') + '\r\n');

      break;
    case 'CWD':
      // Change working directory.
      if (!internals.authenticated()) {
        break;
      }

      var path = PathModule.join(internals.socket.sandbox, PathModule.resolve(internals.socket.fs.cwd(), commandArg));

      fs.exists(path, function(exists) {
        if (!exists) {
          internals.socket.write('550 Folder not found.\r\n');
          return;
        }
        internals.socket.write('250 CWD successful. \"' + internals.socket.fs.chdir(commandArg) + '\" is current directory\r\n');
      });

      break;
    case 'DELE':
      // Delete file.
      if (!internals.authenticated()) {
        break;
      }

      var filename = PathModule.resolve(internals.socket.fs.cwd(), commandArg);

      fs.unlink(PathModule.join(internals.socket.sandbox, filename), function(err) {
        if (err) {
          internals.logIf(0, 'Error deleting file: ' + filename + ', ' + err, internals.socket);
          // write error to internals.socket
          internals.socket.write('550 Permission denied\r\n');
        } else {
          internals.socket.write('250 File deleted\r\n');
        }
      });
      break;

    case 'FEAT':
      // Get the feature list implemented by the internals.server. (RFC 2389)
      internals.socket.write('211-Features\r\n');
      internals.socket.write(' SIZE\r\n');
      internals.socket.write('211 end\r\n');

      break;
    case 'LIST':
      // Returns information of a file or directory if specified, else information of the current working directory is returned.
      if (!internals.authenticated()) {
        break;
      }

      internals.whenDataWritable(function(dataSocket) {

        var leftPad = function(text, width) {
          var out = '';

          for (var j = text.length; j < width; j++) {
            out += ' ';
          }

          out += text;

          return out;
        };

        // This will be called once data has ACTUALLY written out ... internals.socket.write() is async!
        var success = function() {
          internals.socket.write('226 Transfer OK\r\n');
          dataSocket.end();
        };

        var failure = function() {
          dataSocket.end();
        };

        var path = PathModule.join(internals.socket.sandbox, internals.socket.fs.cwd());
        if (dataSocket.readable) {
          dataSocket.resume();
        }

        internals.logIf(3, 'Sending file list', internals.socket);

        fs.readdir(path, function(err, files) {
          if (err) {
            internals.logIf(0, 'While sending file list, reading directory: ' + err, internals.socket);
            dataSocket.write('', failure);
          } else {
            // Wait until acknowledged!
            internals.socket.write('150 Here comes the directory listing\r\n', function() {
              internals.logIf(3, 'Directory has ' + files.length + ' files', internals.socket);
              for (var i = 0; i < files.length; i++) {
                var file = files[i];
                var s = fs.statSync(PathModule.join(path, file));
                var line = s.isDirectory() ? 'd' : '-';
                if (i > 0) dataSocket.write('\r\n');
                line += (0400 & s.mode) ? 'r' : '-';
                line += (0200 & s.mode) ? 'w' : '-';
                line += (0100 & s.mode) ? 'x' : '-';
                line += (040 & s.mode) ? 'r' : '-';
                line += (020 & s.mode) ? 'w' : '-';
                line += (010 & s.mode) ? 'x' : '-';
                line += (04 & s.mode) ? 'r' : '-';
                line += (02 & s.mode) ? 'w' : '-';
                line += (01 & s.mode) ? 'x' : '-';
                line += ' 1 ftp ftp ';
                line += leftPad(s.size.toString(), 12) + ' ';
                var d = new Date(s.mtime);
                line += leftPad(d.format('M d H:i'), 12) + ' '; // need to use a date string formatting lib
                line += file;
                dataSocket.write(line);
              }
              // write the last bit, so we can know when it's finished
              dataSocket.write('\r\n', success);
            });
          }
        });
      });
      break;

    case 'MKD':
      // Make directory.
      if (!internals.authenticated()) {
        break;
      }

      var filename = PathModule.resolve(internals.socket.fs.cwd(), commandArg);

      fs.mkdir(PathModule.join(internals.socket.sandbox, filename), 0755, function(err) {
        if (err) {
          internals.logIf(0, 'Error making directory ' + filename + ' because ' + err, internals.socket);
          // write error to internals.socket
          internals.socket.write('550 \"' + filename + '\" directory NOT created\r\n');

          return;
        }

        internals.socket.write('257 \"' + filename + '\" directory created\r\n');

      });

      break;
    case 'NLST':
      // Returns a list of file names in a specified directory.
      if (!internals.authenticated()) {
        break;
      }

      /**
      Normally the server responds with a mark using code 150. It then stops accepting new connections, attempts to send the contents of the directory over the data connection, and closes the data connection. Finally it

          accepts the LIST or NLST request with code 226 if the entire directory was successfully transmitted;
          rejects the LIST or NLST request with code 425 if no TCP connection was established;
          rejects the LIST or NLST request with code 426 if the TCP connection was established but then broken by the client or by network failure; or
          rejects the LIST or NLST request with code 451 if the server had trouble reading the directory from disk.

      The server may reject the LIST or NLST request (with code 450 or 550) without first responding with a mark. In this case the server does not touch the data connection.
       *
       */

      internals.whenDataWritable(function(dataSocket) {
        // This will be called once data has ACTUALLY written out ... internals.socket.write() is async!
        var success = function() {
          internals.socket.write('226 Transfer OK\r\n');
          dataSocket.end();
        };

        var failure = function() {
          dataSocket.end();
        };

        // Use temporary filesystem path maker since a path might be sent with NLST
        var temp = '';
        if (commandArg) {
          // Remove double slashes or "up directory"
          commandArg = commandArg.replace(/\/{2,}|\.{2}/g, '');

          if (commandArg.substr(0, 1) == '/') {
            temp = PathModule.join(internals.socket.sandbox, commandArg);
          } else {
            temp = PathModule.join(internals.socket.sandbox, internals.socket.fs.cwd(), commandArg);
          }
        } else {
          temp = PathModule.join(internals.socket.sandbox, internals.socket.fs.cwd());
        }

        if (dataSocket.readable) {
          dataSocket.resume();
        }

        internals.logIf(3, 'Sending file list', internals.socket);

        glob.glob(temp, function(err, files) {
          //fs.readdir(internals.socket.sandbox + temp.cwd(), function(err, files) {
          if (err) {
            internals.logIf(0, 'During NLST, error globbing files: ' + err, internals.socket);
            internals.socket.write('451 Read error\r\n');
            dataSocket.write('', failure);
            return;
          }

          // Wait until acknowledged!
          internals.socket.write('150 Here comes the directory listing\r\n', function() {
            internals.logIf(3, 'Directory has ' + files.length + ' files', internals.socket);
            dataSocket.write(files.map(PathModule.basename).join('\015\012') + '\015\012', success);
          });
        });
      });
      break;

    case 'PASS':
      // Authentication password.
      internals.socket.emit(
          'command:pass',
          commandArg,
          function(username) { // implementor should call this on successful password check
            internals.socket.write('230 Logged on\r\n');
            internals.socket.username = username;
            internals.socket.sandbox = PathModule.join(internals.server.baseSandbox, username);
          },
          function() { // call second callback if password incorrect
            internals.socket.write('530 Invalid password\r\n');
            internals.socket.authFailures++;
            internals.socket.username = null;
          }
      );
      break;
    case 'PASV':
      // Enter passive mode. This creates the listening internals.socket.
      if (!internals.authenticated()) {
        break;
      }

      // not sure whether the spec limits to 1 data connection at a time ...
      if (internals.socket.dataListener) {
        internals.socket.dataListener.close(); // we're creating a new listener
      }

      if (internals.socket.dataSocket) {
        internals.socket.dataSocket.end(); // close any existing connections
      }

      internals.socket.dataListener = null;
      internals.socket.dataSocket = null;
      internals.socket.pause(); // Pause processing of further commands

      var pasv = net.createServer(function(pasvSocket) {
        internals.logIf(1, 'Incoming passive data connection', internals.socket);
        pasvSocket.pause(); // Pause until data listeners are in place

        pasvSocket.on('data', function(data) {
          // should watch out for malicious users uploading large amounts of data outside protocol
          internals.logIf(4, 'Data event: received ' + (Buffer.isBuffer(data) ? 'buffer' : 'string'), internals.socket);
        });

        pasvSocket.on('end', function() {
          internals.logIf(3, 'Passive data event: end', internals.socket);
          // remove pointer
          internals.socket.dataSocket = null;

          if (internals.socket.readable) {
            internals.socket.resume(); // just in case
          }
        });

        pasvSocket.addListener('error', function(err) {
          internals.logIf(0, 'Passive data event: error: ' + err, internals.socket);
          internals.socket.dataSocket = null;

          if (internals.socket.readable) {
            internals.socket.resume();
          }
        });

        pasvSocket.addListener('close', function(had_error) {
          internals.logIf(
              (had_error ? 0 : 3),
              'Passive data event: close ' + (had_error ? ' due to error' : ''),
              internals.socket
          );
          if (internals.socket.readable) {
            internals.socket.resume();
          }
        });

        // Once we have a completed data connection, make note of it
        internals.socket.dataSocket = pasvSocket;

        // 150 should be sent before we send data on the data connection
        //internals.socket.write("150 Connection Accepted\r\n");
        if (internals.socket.readable) {
          internals.socket.resume();
        }

        // Emit this so the pending callback gets picked up in whenDataWritable()
        internals.socket.dataListener.emit('data-ready', pasvSocket);

      });

      // Once we're successfully listening, tell the client
      pasv.addListener('listening', function() {
        var host = pasv.address().address;
        var port = pasv.address().port;
        internals.socket.passive = true; // wait until we're actually listening
        internals.socket.dataHost = host;
        internals.socket.dataPort = port;
        internals.logIf(3, 'Passive data connection listening on port ' + port, internals.socket);
        var i1 = parseInt(port / 256);
        var i2 = parseInt(port % 256);
        internals.socket.write('227 Entering Passive Mode (' + host.split('.').join(',') + ',' + i1 + ',' + i2 + ')\r\n');
      });

      pasv.on('close', function() {
        internals.logIf(3, 'Passive data listener closed', internals.socket);
        if (internals.socket.readable) {
          internals.socket.resume(); // just in case
        }
      });

      pasv.listen(0);
      internals.socket.dataListener = pasv;
      internals.logIf(3, 'Passive data connection beginning to listen', internals.socket);

      break;

    case 'PORT':
      // Specifies an address and port to which the server should connect.
      if (!internals.authenticated()) {
        break;
      }

      internals.socket.passive = false;
      internals.socket.dataSocket = null;

      var addr = commandArg.split(',');

      internals.socket.dataHost = addr[0] + '.' + addr[1] + '.' + addr[2] + '.' + addr[3];
      internals.socket.dataPort = (parseInt(addr[4]) * 256) + parseInt(addr[5]);
      internals.socket.write('200 PORT command successful.\r\n');

      break;
    case 'PWD':
      // Print working directory. Returns the current directory of the host.
      if (!internals.authenticated()) {
        break;
      }

      internals.socket.write('257 \"' + internals.socket.fs.cwd() + '\" is current directory\r\n');

      break;

    case 'QUIT':
      // Disconnect.
      internals.socket.write('221 Goodbye\r\n');
      internals.socket.end();
      internals.closeDataConnections();
      break;

    case 'RETR':
      // Retrieve (download) a remote file.
      internals.whenDataWritable(function(dataSocket) {
        dataSocket.setEncoding(internals.socket.mode);

        var filename = PathModule.resolve(internals.socket.fs.cwd(), commandArg);
        var from = fs.createReadStream(PathModule.join(internals.socket.sandbox, filename), {flags: 'r'});
        from.on('error', function() {
          internals.logIf(2, 'Error reading file');
        });

        from.on('end', function() {
          internals.logIf(3, 'DATA file ' + filename + ' closed');
          dataSocket.end();
          internals.socket.write('226 Closing data connection\r\n');
        });

        internals.logIf(3, 'DATA file ' + filename + ' opened');

        internals.socket.write('150 Opening ' + internals.socket.mode.toUpperCase() + ' mode data connection\r\n');

        if (dataSocket.readable) {
          dataSocket.resume();
          from.pipe(dataSocket);
        }

      });
      break;
    case 'RMD':
      // Remove a directory.
      if (!internals.authenticated()) {
        break;
      }

      var filename = PathModule.resolve(internals.socket.fs.cwd(), commandArg);
      fs.rmdir(PathModule.join(internals.socket.sandbox, filename), function(err) {
        if (err) {
          internals.logIf(0, 'Error removing directory ' + filename, internals.socket);
          internals.socket.write('550 Delete operation failed\r\n');
        } else {
          internals.socket.write('250 \"' + filename + '\" directory removed\r\n');
        }
      });
      break;
    case 'RNFR':
      // Rename from.
      if (!internals.authenticated()) {
        break;
      }

      internals.socket.filefrom = PathModule.resolve(internals.socket.fs.cwd(), commandArg);
      internals.logIf(3, 'Rename from ' + internals.socket.filefrom, internals.socket);

      fs.exists(PathModule.join(internals.socket.sandbox, internals.socket.filefrom), function(exists) {
        if (exists) {
          internals.socket.write('350 File exists, ready for destination name\r\n');
        } else {
          internals.socket.write('350 Command failed, file does not exist\r\n');
        }
      });
      break;
    case 'RNTO':
      // Rename to.
      if (!internals.authenticated()) {
        break;
      }

      var fileto = PathModule.resolve(internals.socket.fs.cwd(), commandArg);
      fs.rename(PathModule.join(internals.socket.sandbox, internals.socket.filefrom), PathModule.join(internals.socket.sandbox, fileto), function(err) {
        if (err) {
          internals.logIf(3, 'Error renaming file from ' + internals.socket.filefrom + ' to ' + fileto, internals.socket);
          internals.socket.write('550 Rename failed\r\n');
        } else {
          internals.socket.write('250 File renamed successfully\r\n');
        }
      });
      break;
    case 'SIZE':
      // Return the size of a file. (RFC 3659)
      if (!internals.authenticated()) {
        break;
      }

      var filename = PathModule.resolve(internals.socket.fs.cwd(), commandArg);

      fs.stat(PathModule.join(internals.socket.sandbox, filename), function(err, s) {
        if (err) {
          internals.logIf(0, 'Error getting size of file: ' + filename, internals.socket);
          internals.socket.write('450 Failed to get size of file\r\n');
          return;
        }

        internals.socket.write('213 ' + s.size + '\r\n');
      });

      break;

    case 'STOR':
      // Store (upload) a file.
      if (!internals.authenticated()) {
        break;
      }

      internals.whenDataWritable(function(dataSocket) {
        // dataSocket comes to us paused, so we have a chance to create the file before accepting data
        filename = PathModule.resolve(internals.socket.fs.cwd(), commandArg);
        var destination = fs.createWriteStream(PathModule.join(internals.socket.sandbox, filename), {flags: 'w+', mode: 0644});
        destination.on('error', function(err) {
          internals.logIf(0, 'Error opening/creating file: ' + filename, internals.socket);
          internals.socket.write('553 Could not create file\r\n');
          dataSocket.end();
        });

        destination.on('close', function() {
          // Finished
        });

        internals.logIf(3, 'File opened/created: ' + filename, internals.socket);

        dataSocket.addListener('end', function() {
          internals.socket.write('226 Data connection closed\r\n');
        });

        dataSocket.addListener('error', function(err) {
          internals.logIf(0, 'Error transferring ' + filename + ': ' + err, internals.socket);
        });

        internals.logIf(3, 'Told client ok to send file data', internals.socket);

        internals.socket.write('150 Ok to send data\r\n'); // don't think resume() needs to wait for this to succeed
        if (dataSocket.readable) {
          dataSocket.resume();
          // Let pipe() do the dirty work ... it'll keep both streams in sync
          dataSocket.pipe(destination);
        }
      });

      break;
    case 'SYST':
      // Return system type.
      internals.socket.write('215 UNIX emulated by NodeFTPd\r\n');
      break;
    case 'TYPE':
      // Sets the transfer mode (ASCII/Binary).
      if (!internals.authenticated()) {
        break;
      }

      if (commandArg == 'A') {
        internals.socket.mode = 'ascii';
        internals.socket.write('200 Type set to A\r\n');
      } else {
        internals.socket.mode = 'binary';
        internals.socket.write('200 Type set to I\r\n');
      }

      break;
    case 'USER':
      // Authentication username.
      internals.socket.emit(
          'command:user',
          commandArg,
          function() { // implementor should call this on successful password check
            internals.socket.write('331 Password required for ' + commandArg + '\r\n');
          },
          function() { // call second callback if password incorrect
            internals.socket.write('530 Invalid username: ' + commandArg + '\r\n');
          }
      );
      break;
    case 'XPWD':
      //
      internals.socket.write('257 ' + internals.socket.fs.cwd() + ' is the current directory\r\n');
      break;
    default:
      internals.socket.write('202 Not supported\r\n');
      break;
  }
};


util.inherits(internals.createServer, process.EventEmitter);

exports.createServer = internals.createServer;
