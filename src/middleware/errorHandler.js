const errorHandler = (err, req, res, next) => {
  console.error('Error:', err);

  // Erreur de validation posée volontairement : sa prose est écrite pour être
  // lue, contrairement à un message de driver.
  if (err.type === 'validation') {
    return res.status(400).json({ error: err.message, code: 'VALIDATION_FAILED' });
  }

  if (err.code === 'ER_DUP_ENTRY') {
    return res.status(409).json({ error: 'Entrée en double', code: 'DUPLICATE_ENTRY' });
  }

  if (err.code === 'ER_NO_REFERENCED_2') {
    return res.status(400).json({ error: 'Référence invalide', code: 'INVALID_REFERENCE' });
  }

  res.status(500).json({ error: 'Erreur interne du serveur', code: 'INTERNAL' });
};

module.exports = errorHandler;