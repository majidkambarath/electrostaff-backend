// Site money rules — pure. Profit uses the contract value when one is set, otherwise what the
// client has paid so far.
const financeSummary = ({ contractValue = 0, received = 0, labourCost = 0, expenses = 0 }) => {
  const totalCost = labourCost + expenses;
  const revenue = contractValue > 0 ? contractValue : received;
  const profit = revenue - totalCost;
  return {
    contractValue,
    received,
    due: Math.max(0, contractValue - received),
    labourCost,
    expenses,
    totalCost,
    profit,
    margin: revenue > 0 ? Math.round((profit / revenue) * 100) : null,
  };
};

module.exports = { financeSummary };
