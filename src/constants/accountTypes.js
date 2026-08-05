const ACCOUNT_TYPE = Object.freeze({
  PERSONNEL: 0,
  BUSINESS: 1,
  OFFICIEL: 2,
});

const VERIFICATION = Object.freeze({
  NON_DEMANDE: 0,
  EN_COURS: 1,
  VERIFIE: 2,
  REFUSE: 3,
  EXPIRE: 4,
  REVOQUE: 5,
});

module.exports = { ACCOUNT_TYPE, VERIFICATION };
