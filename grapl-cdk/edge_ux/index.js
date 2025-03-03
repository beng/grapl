// Stylesheets

console.log('Loaded index.js');

const engagement_edge = "";
console.log(`Connecting to ${engagement_edge}`);

const getLenses = async () => {
    const res = await fetch(`${engagement_edge}getLenses`, {
        method: 'post',
        body: JSON.stringify({
            'prefix': '',
        })
    });

    return await res.json();
};

const nodeToTable = (lens) => {

    let header = '<thead class="thead"><tr>';
    let output = '<tbody><tr>';
    header += `<th scope="col">lens</th>`;
    header += `<th scope="col">score</th>`;
    header += `<th scope="col">link</th>`;

    output += `<td>${lens.lens}</td>>`;
    output += `<td>${lens.score}</td>>`;
    // output += `<td><a href="${engagement_edge}lens.html?lens=${lens.lens}">link</td></a>>`;
    output += `<td><a href="lens.html?lens=${lens.lens}">link</td></a>>`;


    return `${header}</tr></thead>` + `${output}</tr><tbody>`;
};

const getLensesLoop = () => {

};

document.addEventListener('DOMContentLoaded', async (event) => {
    console.log('DOMContentLoaded');

    const lenses = (await getLenses()).lenses;
    console.log(lenses);

    if (lenses.length === 0) {
        console.log("No active lenses");
        return
    }

    const lenseTable = document.getElementById('LenseTable');

    const lensRows = [];

    for (const lens of lenses) {
        const s = nodeToTable(lens);
        lensRows.push(s);
    }
    // Sort the lenses by their score
    lensRows.sort((row_a, row_b) => {
       return row_a.score - row_b.score
    });
    const lensRowsStr = lensRows.join("")
    lenseTable.innerHTML = `<table>${lensRowsStr}</table>`;


});