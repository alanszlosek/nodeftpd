nodeftpd - a simple FTP server written in Node.JS
====

Welcome
----

This is turning out to be quite a deviation from the original code. Figured that if there's a need for an ftp server written in node.js, one probably needs to tack on custom functionality, otherwise they'd just use vsftpd. So my goal is to lay the groundwork for a basic FTP server, with all the right hooks in place for customizing operations.

I assume you'll want to customize:

* User authentication (user and pass commands)
* Base folder for file operations
* What happens when certain file commands are performed

For my specific needs (at work) we needed custom user authentication, to sandbox all the file operations, and to run special code when a file is uploaded.

Thanks, Alan

Status
----

To Do

* Fire more events to allow customizations: directory changes, file uploads, etc
* Unsupported commands:


```
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
    // Sends site specific commands to remote internals.server.
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
```


Known issues

* None at the moment

These are known to work (or mostly work)

* Passive data connection establishment
* Non-passive data connection establishment
* CWD - change working directory
* DELE - delete file
* LIST - had to construct the list format programmatically because output from `ls -l` wasn't being processed by FireFTP
* MKD - make directory
* RMD - remove directory (and contents)
* STOR - upload
* RETR - download

If a command is not listed, I probably haven't tested it yet.

How to use
----

See test.js for an example.

Then implement the following event callbacks with logic you need performed:

* command:user - Same as command:pass above, but first parameter will be the username that was sent from the client.
* command:pass - Sends three params. The first is the password. The second is a callback to be called if you determine the password is correct ... pass the username as the first parameter to this callback. Call the second if incorrect.

Also, don't run node as root just so you can get access to the FTP port. We run our node FTP server as an unprivileged user and perform port-forwarding with iptables. The following should work for you as well:

> iptables -A PREROUTING -t nat -i eth0 -p tcp --dport 21 -j REDIRECT --to-port 10000

17 April 2012
----

Added LICENSE.txt with MIT license. Original code base had none, my changes are a pretty big deviation, and people have been asking.

04 September 2011
----

Tested passive and non-passive data connections and found some issues, so I did some re-working.

Some things that might be nice:

* Figure out how it should be run, maybe as root first but execs to another user
* Fork new process when client connects and authenticates

Old Readme Follows ...
----

### 28 March 2010

Forked from http://github.com/billywhizz/nodeftpd
Andrew Johnston - http://blog.beardsoft.com/node-ftp-server-initial-release

Andrew's initial release was tested about node.js 0.1.21
In the few short months since that release, node.js has changed quite a bit
to where it is now, at time of writing 0.1.33

Changes made to nodeftp are as follows:

1. POSIX module has now been moved to FS (0.1.29)
2. File module has been removed (0.1.29)
3. sys.exec callback system seems to have changed??
   - as such quite a lot of moving about and rehacking had to take place:
   - LIST/NLIST
   - DEL
   - STOR
   - RETR
   - RNTO
4. tcp has changed function names and listeners
5. Rewrote ftptest.js as well
7. Changed ports to 7001/7002 so I can test without being root
8. Finally. Reformatted for my Emacs and javascript-mode

Also, not tested in Passive mode yet, but I think it works??

One thing I had problems with was the root filesystem of the FTP server.
Even though I was running the ftpd.js from /home/rob/workspace it changed
it to "/". This meant that if I tried to get the SIZE of a file, eg:
/home/rob/workspace/file.txt
it tried to get the SIZE of
/home/rob/workspace//home/rob/workspace/file.txt
I narrowed this down to the dummyfs.js functionality, but then
if I changed the dummyfs root there was repeating of the path names

TODO
- Fix the repeating file paths problem
- Add in non-anonymous logins
- Implement non-implemented functionality (see ftpd.js TODO list)
- Add in proper error checking
- Test in passive mode

### 20 June 2010

Updated for node v0.1.98
