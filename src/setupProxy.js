module.exports = function(app) {
    app.use('/', function(req, res, next) {
      res.set({
        'Cross-Origin-Opener-Policy': 'same-origin',
        'Cross-Origin-Embedder-Policy': 'require-corp'
      });
      next();
    });
  };