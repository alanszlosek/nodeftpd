var net = require("net");
var util = require("util");
var fs = require("fs");
var dummyfs = require("./dummyfs");
var PathModule = require("path");
var glob = require('./glob');
require('./date-format');

/*
TODO:
- Implement Full RFC 959
- Implement RFC 2428
- Implement RFC 2228
- Implement RFC 3659
- Implement TLS - http://en.wikipedia.org/wiki/FTPS

*/


// host should be an IP address, and sandbox a path without trailing slash for now
function createServer(host, sandbox, virtualFS) {
    if(virtualFS){
    	fs = virtualFS;
    }
    // make sure host is an IP address, otherwise DATA connections will likely break
    var server = net.createServer();
    server.baseSandbox = sandbox; // path which we're starting relative to
    server.debugging = 0;

    var logIf = function(level, message, socket) {
        if (server.debugging >= level) {
            if (socket)
                console.log(socket.remoteAddress + ": " + message);
            else
                console.log(message);
        }
    };

    server.on("listening", function() {
        logIf(0, "nodeFTPd server up and ready for connections");
    });
    server.on("connection", function(socket) {
        server.emit("client:connected", socket); // pass socket so they can listen for client-specific events

        socket.setTimeout(0); // We want to handle timeouts ourselves
        socket.setEncoding("ascii"); // force data String not Buffer, so can parse FTP commands as a string
        socket.setNoDelay();
        
        socket.passive = false;
        socket.dataHost = null;
        socket.dataPort = 20; // default
        socket.dataListener = null; // for incoming passive connections
        socket.dataSocket = null; // the actual data socket
        socket.mode = "ascii";
        socket.filefrom = "";
        // Authentication
        socket.authFailures = 0; // 3 tries then we disconnect you
        socket.username = null;

        socket.sandbox = sandbox; // after authentication we'll tack on a user-specific subfolder
        socket.fs = new dummyfs.dummyfs("/");
        logIf(0, "Base FTP directory: "+socket.fs.cwd());


        var authenticated = function() {
            // send a message if not authenticated?
            return (socket.username ? true : false);
        };

        var authFailures = function() {
            if (socket.authFailures >= 2) {
                socket.end();
                return true;
            }
            return false;
        };

        var closeDataConnections = function() {
            if (socket.dataListener) socket.dataListener.close(); // we're creating a new listener
            if (socket.dataSocket) socket.dataSocket.end(); // close any existing connections
        };

        // Purpose of this is to ensure a valid data connection, and run the callback when it's ready
        var whenDataWritable = function(callback) {
            if (socket.passive) {
                // how many data connections are allowed?
                // should still be listening since we created a server, right?
                if (socket.dataSocket) {
                    logIf(3, "A data connection exists", socket);
                    if (callback) callback(socket.dataSocket); // do!
                } else {
                    logIf(3, "Passive, but no data socket exists ... waiting", socket);
                    socket.dataListener.on('data-ready', function(dataSocket) {
                        logIf(3, "Looks like waiting paid off. Here we go!");
                        callback(dataSocket);
                    });
                    //socket.write("425 Can't open data connection\r\n");
                }
            } else {
                // Do we need to open the data connection?
                if (socket.dataSocket) { // There really shouldn't be an existing connection
                    logIf(3, "Using existing non-passive dataSocket", socket);
                    callback(socket.dataSocket);
                } else {
                    logIf(1, "Opening data connection to " + socket.dataHost + ":" + socket.dataPort, socket);
                    var dataSocket = new net.Socket();
                    // Since data may arrive once the connection is made, pause it right away
                    dataSocket.on("data", function(data) {
                        logIf(3, dataSocket.remoteAddress + ' event: data ; ' + (Buffer.isBuffer(data) ? 'buffer' : 'string'));
                    });
                    dataSocket.addListener("connect", function() {
                        dataSocket.pause(); // Pause until the data listeners are in place
                        socket.dataSocket = dataSocket;
                        logIf(3, "Data connection succeeded", socket);
                        callback(dataSocket);
                    });
                    dataSocket.addListener("close", function(had_error) {
                        socket.dataSocket = null;
                        if (had_error)
                            logIf(0, "Data event: close due to error", socket);
                        else
                            logIf(3, "Data event: close", socket);
                    });
                    dataSocket.addListener("end", function() {
                        logIf(3, "Data event: end", socket);
                    });
                    dataSocket.addListener("error", function(err) {
                        logIf(0, "Data event: error: " + err, socket);
                        dataSocket.destroy();
                    });
                    dataSocket.connect(socket.dataPort, socket.dataHost);
                }
            }
        };

        socket.addListener("data", function (data) {
            data = (data+'').trim();
            logIf(2, "FTP command: " + data, socket);

            var command, commandArg;
            var index = data.indexOf(" ");
            if (index > 0) {
                command = data.substring(0, index).trim().toUpperCase();
                commandArg = data.substring(index+1, data.length).trim();
            } else {
                command = data.trim().toUpperCase();
                commandArg = '';
            }
            // Separate authenticated versus not?

            switch(command) {
                case "CDUP":
                    // Change to Parent Directory.
                    if (!authenticated()) break;
                    socket.write("250 Directory changed to " + socket.fs.chdir("..") + "\r\n");
                    break;
                case "CWD":
                    // Change working directory.
                    if (!authenticated()) break;
                    var path = PathModule.join(socket.sandbox, PathModule.resolve(socket.fs.cwd(), commandArg));
                    fs.exists(path, function(exists) {
                        if (!exists) {
                            socket.write("550 Folder not found.\r\n");
                            return;
                        }
                        socket.write("250 CWD successful. \"" + socket.fs.chdir(commandArg) + "\" is current directory\r\n");
                    });
                    break;
                case "DELE":
                    // Delete file.
                    if (!authenticated()) break;
                    var filename = PathModule.resolve(socket.fs.cwd(), commandArg);
                    fs.unlink( PathModule.join(socket.sandbox, filename), function(err){
                        if (err) {
                            logIf(0, "Error deleting file: "+filename+", "+err, socket);
                            // write error to socket
                            socket.write("550 Permission denied\r\n");
                        } else
                            socket.write("250 File deleted\r\n");
                    });
                    break;
            
                case "FEAT":
                    // Get the feature list implemented by the server. (RFC 2389)
                    socket.write("211-Features\r\n");
                    socket.write(" SIZE\r\n");
                    socket.write("211 end\r\n");
                    break;
                case "LIST":
                    // Returns information of a file or directory if specified, else information of the current working directory is returned.
                    if (!authenticated()) break;

                    whenDataWritable( function(dataSocket) {
                        var leftPad = function(text, width) {
                            var out = '';
                            for (var j = text.length; j < width; j++) out += ' ';
                            out += text;
                            return out;
                        };
                        // This will be called once data has ACTUALLY written out ... socket.write() is async!
                        var success = function() {
                            socket.write("226 Transfer OK\r\n");
                            dataSocket.end();
                        };
                        var failure = function() {
                            dataSocket.end();
                        };
                        var path = PathModule.join(socket.sandbox, socket.fs.cwd());
                        if (dataSocket.readable) dataSocket.resume();
                        logIf(3, "Sending file list", socket);
                        fs.readdir(path, function(err, files) {
                            if (err) {
                                logIf(0, "While sending file list, reading directory: " + err, socket);
                                dataSocket.write("", failure);
                            } else {
                                // Wait until acknowledged!
                                socket.write("150 Here comes the directory listing\r\n", function() {
                                    logIf(3, "Directory has " + files.length + " files", socket);
                                    for (var i = 0; i < files.length; i++) {
                                        var file = files[ i ];
                                        var s = fs.statSync( PathModule.join(path, file) );
                                        var line = s.isDirectory() ? 'd' : '-';
                                        if (i > 0) dataSocket.write("\r\n");
                                        line += (0400 & s.mode) ? 'r' : '-';
                                        line += (0200 & s.mode) ? 'w' : '-';
                                        line += (0100 & s.mode) ? 'x' : '-';
                                        line += (040 & s.mode) ? 'r' : '-';
                                        line += (020 & s.mode) ? 'w' : '-';
                                        line += (010 & s.mode) ? 'x' : '-';
                                        line += (04 & s.mode) ? 'r' : '-';
                                        line += (02 & s.mode) ? 'w' : '-';
                                        line += (01 & s.mode) ? 'x' : '-';
                                        line += " 1 ftp ftp ";
                                        line += leftPad(s.size.toString(), 12) + ' ';
                                        var d = new Date(s.mtime);
                                        line += leftPad(d.format('M d H:i'), 12) + ' '; // need to use a date string formatting lib
                                        line += file;
                                        dataSocket.write(line);
                                    }
                                    // write the last bit, so we can know when it's finished
                                    dataSocket.write("\r\n", success);
                                });
                            }
                        });
                    });
                    break;
            
                case "MKD":
                    // Make directory.
                    if (!authenticated()) break;
                    var filename = PathModule.resolve(socket.fs.cwd(), commandArg);
                    fs.mkdir( PathModule.join(socket.sandbox, filename), 0755, function(err){
                        if(err) {
                            logIf(0, "Error making directory " + filename + " because " + err, socket);
                            // write error to socket
                            socket.write("550 \""+filename+"\" directory NOT created\r\n");
                            return;
                        }
                        socket.write("257 \""+filename+"\" directory created\r\n");
                    });
                    break;
                case "NLST":
                    // Returns a list of file names in a specified directory.
                    if (!authenticated()) break;
                
                    /*
                    Normally the server responds with a mark using code 150. It then stops accepting new connections, attempts to send the contents of the directory over the data connection, and closes the data connection. Finally it

                        accepts the LIST or NLST request with code 226 if the entire directory was successfully transmitted;
                        rejects the LIST or NLST request with code 425 if no TCP connection was established;
                        rejects the LIST or NLST request with code 426 if the TCP connection was established but then broken by the client or by network failure; or
                        rejects the LIST or NLST request with code 451 if the server had trouble reading the directory from disk.

                    The server may reject the LIST or NLST request (with code 450 or 550) without first responding with a mark. In this case the server does not touch the data connection.
                    */

                    whenDataWritable( function(dataSocket) {
                        // This will be called once data has ACTUALLY written out ... socket.write() is async!
                        var success = function() {
                            socket.write("226 Transfer OK\r\n");
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
                                temp = PathModule.join(socket.sandbox, commandArg);
                            } else {
                                temp = PathModule.join(socket.sandbox, socket.fs.cwd(), commandArg);
                            }
                        } else temp = PathModule.join(socket.sandbox, socket.fs.cwd());
                        if (dataSocket.readable) dataSocket.resume();
                        logIf(3, "Sending file list", socket);
                    
                        glob.glob(temp, function(err, files) {
                        //fs.readdir(socket.sandbox + temp.cwd(), function(err, files) {
                            if (err) {
                                logIf(0, "During NLST, error globbing files: " + err, socket);
                                socket.write("451 Read error\r\n");
                                dataSocket.write("", failure);
                                return;
                            }
                            // Wait until acknowledged!
                            socket.write("150 Here comes the directory listing\r\n", function() {
                                logIf(3, "Directory has " + files.length + " files", socket);
                                dataSocket.write( files.map(PathModule.basename).join("\015\012") + "\015\012", success);
                            });
                        });
                    });
                    break;
            
                case "PASS":
                    // Authentication password.
                    socket.emit(
                        "command:pass",
                        commandArg,
                        function(username) { // implementor should call this on successful password check
                            socket.write("230 Logged on\r\n");
                            socket.username = username;
                            socket.sandbox = PathModule.join(server.baseSandbox, username);
                        },
                        function() { // call second callback if password incorrect
                            socket.write("530 Invalid password\r\n");
                            socket.authFailures++;
                            socket.username = null;
                        }
                    );
                    break;
                case "PASV":
                    // Enter passive mode. This creates the listening socket.
                    if (!authenticated()) break;
                    // not sure whether the spec limits to 1 data connection at a time ...
                    if (socket.dataListener) socket.dataListener.close(); // we're creating a new listener
                    if (socket.dataSocket) socket.dataSocket.end(); // close any existing connections
                    socket.dataListener = null;
                    socket.dataSocket = null;
                    socket.pause(); // Pause processing of further commands
                    var pasv = net.createServer(function(psocket) {
                        logIf(1, "Incoming passive data connection", socket);
                        psocket.pause(); // Pause until data listeners are in place
                        psocket.on("data", function(data) {
                            // should watch out for malicious users uploading large amounts of data outside protocol
                            logIf(4, 'Data event: received ' + (Buffer.isBuffer(data) ? 'buffer' : 'string'), socket);
                        });
                        psocket.on("end", function () {
                            logIf(3, "Passive data event: end", socket);
                            // remove pointer
                            socket.dataSocket = null;
                            if (socket.readable) socket.resume(); // just in case
                        });
                        psocket.addListener("error", function(err) {
                            logIf(0, "Passive data event: error: " + err, socket);
                            socket.dataSocket = null;
                            if (socket.readable) socket.resume();
                        });
                        psocket.addListener("close", function(had_error) {
                            logIf(
                                (had_error ? 0 : 3),
                                "Passive data event: close " + (had_error ? " due to error" : ""),
                                socket
                            );
                            if (socket.readable) socket.resume();
                        });

                        // Once we have a completed data connection, make note of it
                        socket.dataSocket = psocket;

                        // 150 should be sent before we send data on the data connection
                        //socket.write("150 Connection Accepted\r\n");
                        if (socket.readable) socket.resume();

                        // Emit this so the pending callback gets picked up in whenDataWritable()
                        socket.dataListener.emit("data-ready", psocket);

                    });
                    // Once we're successfully listening, tell the client
                    pasv.addListener("listening", function() {
                        var port = pasv.address().port;
                        socket.passive = true; // wait until we're actually listening
                        socket.dataHost = host;
                        socket.dataPort = port;
                        logIf(3, "Passive data connection listening on port " + port, socket);
                        var i1 = parseInt(port / 256);
                        var i2 = parseInt(port % 256);
                        socket.write("227 Entering Passive Mode (" + host.split(".").join(",") + "," + i1 + "," + i2 + ")\r\n");
                    });
                    pasv.on("close", function() {
                        logIf(3, "Passive data listener closed", socket);
                        if (socket.readable) socket.resume(); // just in case
                    });
                    pasv.listen(0);
                    socket.dataListener = pasv;
                    logIf(3, "Passive data connection beginning to listen", socket);
                    break;
            
                case "PORT":
                    // Specifies an address and port to which the server should connect.
                    if (!authenticated()) break;
                    socket.passive = false;
                    socket.dataSocket = null;
                    var addr = commandArg.split(",");
                    socket.dataHost= addr[0]+"."+addr[1]+"."+addr[2]+"."+addr[3];
                    socket.dataPort = (parseInt(addr[4]) * 256) + parseInt(addr[5]);
                    socket.write("200 PORT command successful.\r\n");
                    break;
                case "PWD":
                    // Print working directory. Returns the current directory of the host.
                    if (!authenticated()) break;
                    socket.write("257 \"" + socket.fs.cwd() + "\" is current directory\r\n");
                    break;
                case "QUIT":
                    // Disconnect.
                    socket.write("221 Goodbye\r\n");
                    socket.end();
                    closeDataConnections();
                    break;
            
                case "RETR":
                    // Retrieve (download) a remote file.
                    whenDataWritable( function(dataSocket) {
                        dataSocket.setEncoding(socket.mode);

                        var filename = PathModule.resolve(socket.fs.cwd(), commandArg);
                        var from = fs.createReadStream( PathModule.join(socket.sandbox, filename), {flags:"r"});
                        from.on("error", function () {
                            logIf(2, "Error reading file");
                        });
                        from.on("end", function() {
                            logIf(3, "DATA file " + filename + " closed");
                            dataSocket.end();
                            socket.write("226 Closing data connection\r\n");
                        });
                    
                        logIf(3, "DATA file " + filename + " opened");
                        socket.write("150 Opening " + socket.mode.toUpperCase() + " mode data connection\r\n");

                        if (dataSocket.readable) {
                            dataSocket.resume();
                            from.pipe(dataSocket);
                        }
                    });
                    break;
                case "RMD":
                    // Remove a directory.
                    if (!authenticated()) break;
                    var filename = PathModule.resolve(socket.fs.cwd(), commandArg);
                    fs.rmdir( PathModule.join(socket.sandbox, filename), function(err){
                        if(err) {
                            logIf(0, "Error removing directory "+filename, socket);
                            socket.write("550 Delete operation failed\r\n");
                        } else
                            socket.write("250 \""+filename+"\" directory removed\r\n");
                    });
                    break;
                case "RNFR":
                    // Rename from.
                    if (!authenticated()) break;
                    socket.filefrom = PathModule.resolve(socket.fs.cwd(), commandArg);
                    logIf(3, "Rename from " + socket.filefrom, socket);
                    fs.exists( PathModule.join(socket.sandbox, socket.filefrom), function(exists) {
                        if (exists) socket.write("350 File exists, ready for destination name\r\n");
                        else socket.write("350 Command failed, file does not exist\r\n");
                    });
                    break;
                case "RNTO":
                    // Rename to.
                    if (!authenticated()) break;
                    var fileto = PathModule.resolve(socket.fs.cwd(), commandArg);
                    fs.rename( PathModule.join(socket.sandbox, socket.filefrom), PathModule.join(socket.sandbox, fileto), function(err){
                        if(err) {
                            logIf(3, "Error renaming file from "+socket.filefrom+" to "+fileto, socket);
                            socket.write("550 Rename failed\r\n");
                        } else
                            socket.write("250 File renamed successfully\r\n");
                    });
                    break;
                case "SIZE":
                    // Return the size of a file. (RFC 3659)
                    if (!authenticated()) break;
                    var filename = PathModule.resolve(socket.fs.cwd(), commandArg);
                    fs.stat( PathModule.join(socket.sandbox, filename), function (err, s) {
                        if(err) {
                            logIf(0, "Error getting size of file: "+filename, socket);
                            socket.write("450 Failed to get size of file\r\n");
                            return;
                        }
                        socket.write("213 " + s.size + "\r\n");
                    });
                    break;

                case "STOR":
                    // Store (upload) a file.
                    if (!authenticated()) break;
                    whenDataWritable( function(dataSocket) {
                        // dataSocket comes to us paused, so we have a chance to create the file before accepting data
                        filename = PathModule.resolve(socket.fs.cwd(), commandArg);
                        var destination = fs.createWriteStream( PathModule.join(socket.sandbox, filename), {flags: 'w+', mode:0644});
                        destination.on("error", function(err) {
                            logIf(0, 'Error opening/creating file: ' + filename, socket);
                            socket.write("553 Could not create file\r\n");
                            dataSocket.end();
                        });
                        destination.on("close", function() {
                            // Finished
                        });
                    
                        logIf(3, "File opened/created: " + filename, socket);

                        dataSocket.addListener("end", function () {
                            socket.write("226 Data connection closed\r\n");
                        });
                        dataSocket.addListener("error", function(err) {
                            logIf(0, "Error transferring " + filename + ": " + err, socket);
                        });
                        logIf(3, "Told client ok to send file data", socket);
                        socket.write("150 Ok to send data\r\n"); // don't think resume() needs to wait for this to succeed
                        if (dataSocket.readable) {
                            dataSocket.resume();
                            // Let pipe() do the dirty work ... it'll keep both streams in sync
                            dataSocket.pipe(destination);
                        }
                    });
                    break;
                case "SYST":
                    // Return system type.
                    socket.write("215 UNIX emulated by NodeFTPd\r\n");
                    break;
                case "TYPE":
                    // Sets the transfer mode (ASCII/Binary).
                    if (!authenticated()) break;
                    if(commandArg == "A"){
                        socket.mode = "ascii";
                        socket.write("200 Type set to A\r\n");
                    }
                    else{
                        socket.mode = "binary";
                        socket.write("200 Type set to I\r\n");
                    }
                    break;
                case "USER":
                    // Authentication username.
                    socket.emit(
                        "command:user",
                        commandArg,
                        function() { // implementor should call this on successful password check
                            socket.write("331 Password required for " + commandArg + "\r\n");
                        },
                        function() { // call second callback if password incorrect
                            socket.write("530 Invalid username: " + commandArg + "\r\n");
                        }
                    );
                    break;
                case "XPWD":
                    // 
                    socket.write("257 " + socket.fs.cwd() + " is the current directory\r\n");
                    break;
                default:
                    socket.write("202 Not supported\r\n");
                    break;
            }
            
            // Unsupported
            /*
            switch (command) {
                case "ABOR":
                    // Abort an active file transfer.
                case "ACCT":
                    // Account information
                case "ADAT":
                    // Authentication/Security Data (RFC 2228)
                case "ALLO":
                    // Allocate sufficient disk space to receive a file.
                case "APPE":
                    // Append.
                case "AUTH":
                    // Authentication/Security Mechanism (RFC 2228)
                case "CCC":
                    // Clear Command Channel (RFC 2228)
                case "CONF":
                    // Confidentiality Protection Command (RFC 697)
                case "ENC":
                    // Privacy Protected Channel (RFC 2228)
                case "EPRT":
                    // Specifies an extended address and port to which the server should connect. (RFC 2428)
                case "EPSV":
                    // Enter extended passive mode. (RFC 2428)
                case "HELP":
                    // Returns usage documentation on a command if specified, else a general help document is returned.
                            214-The following commands are recognized:
                            USER   PASS   QUIT   CWD    PDD    PORT   PASV   TYPE
                            LIST   REST   CDUP   RETR   STOR   SIZE   DELE   RMD
                            MKD    RNFR   RNTO   ABOR   SYST   NOOP   APPE   NLST
                            MDTM   XPWD   XCUP   XMKD   XRMD   NOP    EPSV   EPRT
                            AUTH   ADAT   PBSZ   PROT   FEAT   MODE   OPTS   HELP
                            ALLO   MLST   MLSD   SITE   P@SW   STRU   CLNT   MFMT
                            214 Have a nice day.
                case "LANG":
                    // Language Negotiation (RFC 2640)
                case "LPRT":
                    // Specifies a long address and port to which the server should connect. (RFC 1639)
                case "LPSV":
                    // Enter long passive mode. (RFC 1639)
                case "MDTM":
                    // Return the last-modified time of a specified file. (RFC 3659)
                case "MIC":
                    // Integrity Protected Command (RFC 2228)
                case "MLSD":
                    // Lists the contents of a directory if a directory is named. (RFC 3659)
                case "MLST":
                    // Provides data about exactly the object named on its command line, and no others. (RFC 3659)
                case "MODE":
                    // Sets the transfer mode (Stream, Block, or Compressed).
                case "NOOP":
                    // No operation (dummy packet; used mostly on keepalives).
                case "OPTS":
                    // Select options for a feature. (RFC 2389)
                case "PBSZ":
                    // Protection Buffer Size (RFC 2228)
                case "REIN":
                    // Re initializes the connection.
                case "REST":
                    // Restart transfer from the specified point.
                case "SITE":
                    // Sends site specific commands to remote server.
                case "SMNT":
                    // Mount file structure.
                case "STAT":
                    // Returns the current status.
                
                    from FileZilla
                            Connected to 192.168.2.100.
                            No proxy connection.
                            Mode: stream; Type: ascii; Form: non-print; Structure: file
                            Verbose: on; Bell: off; Prompting: on; Globbing: on
                            Store unique: off; Receive unique: off
                            Case: off; CR stripping: on
                            Ntrans: off
                            Nmap: off
                            Hash mark printing: off; Use of PORT cmds: on
                            Tick counter printing: off
                case "STOU":
                    // Store file uniquely.
                case "STRU":
                    // Set file transfer structure.
            }
            */
        });

        socket.addListener("end", function () {
            logIf(1, "Client connection ended", socket);
        });
        socket.addListener("error", function (err) {
            logIf(0, "Client connection error: " + err, socket);
        });

        // Tell client we're ready
        logIf(1, "Connection", socket);
        //socket.send("220 NodeFTPd Server version 0.0.10\r\n");
        //socket.write("220 written by Andrew Johnston (apjohnsto@gmail.com)\r\n");
        //socket.write("220 Please visit http://github.com/billywhizz/NodeFTPd\r\n");
        socket.write("220 FTP server (nodeftpd) ready\r\n");
    });

    server.addListener("close", function() {
        logIf(0, "Server closed");
    });

    return server;
}
util.inherits(createServer, process.EventEmitter);
exports.createServer = createServer;
