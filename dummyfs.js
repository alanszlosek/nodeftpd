var path = require("path");

function dummyfs(root) {
    if (!root) root = "/"; // default to actual root ... probably should default to process owner's home instead
    this.dir = root;
}
exports.dummyfs = dummyfs;

dummyfs.prototype.chdir = function(dir) {
	// Updated from path.resolve to path.join, this fixes windows usage
  this.dir = path.join(this.dir, dir);
	return(this.dir);
}

dummyfs.prototype.cwd = function() {
    return(this.dir);
}