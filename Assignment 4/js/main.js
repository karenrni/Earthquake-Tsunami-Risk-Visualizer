
// SVG Size
let width = 700,
	height = 500;



// Load CSV file
d3.csv("data/wealth_health_data.csv", row => {

	console.log(row)
	row.LifeExpectancy = +row.LifeExpectancy
	row.Income = +row.Income
	row.Population = +row.Population
	// TODO: convert values where necessary in this callback (d3.csv reads the csv line by line. In the callback,
	//  you have access to each line (or row) represented as a js object with key value pairs. (i.e. a dictionary).
	return row;
}).then( data => {
	// Analyze the dataset in the web console
	console.log(data);
	console.log("Countries: " + data.length)




	// TODO: sort the data
	data.sort((a, b) => b.Population - a.Population);

	// TODO: Call your separate drawing function here, i.e. within the .then() method's callback function
	drawChart(data);


});

// TODO: create a separate function that is in charge of drawing the data, which means it takes the sorted data as an argument

function drawChart(data) {
	let svg = d3.select("#chart-area").append("svg").attr("width", width).attr("height", height);

	let incomeExtent = [
		d3.min(data, d => d.Income) - 2000,   
		d3.max(data, d => d.Income) + 2000  
	];

	let lifeExpectancyExtent = [
		d3.min(data, d => d.LifeExpectancy) - 2,  
		d3.max(data, d => d.LifeExpectancy) + 2
	]

	let padding = 30;
	// x-axis
	// let incomeScale = d3.scaleLinear().domain(incomeExtent).range([padding, width-padding]);
	
	let incomeScale = d3.scaleLog().domain([
		d3.min(data, d => d.Income),
		d3.max(data, d => d.Income)
	]).range([padding, width-padding])

	// y-axis
	let lifeExpectancyScale = d3.scaleLinear().domain(lifeExpectancyExtent).range([height - padding, padding]);

	console.log(incomeScale(5000));	// Returns: 23.2763
	console.log(lifeExpectancyScale(68));	// Returns: 224.7191

	// radius scale
	let rScale = d3.scaleSqrt()
	.domain(d3.extent(data, d => d.Population))
	.range([4, 30]); // tweak min/max radius to taste

	let regions = Array.from(new Set(data.map(d => d.Region)));

	// color scale
	let colorScale = d3.scaleOrdinal().domain(regions).range(d3.schemeCategory10);

	// circles
	svg.selectAll("circle")
	.data(data)
	.enter()
	.append("circle")
	.attr("cx", d => incomeScale(+d.Income))                 // x uses incomeScale
	.attr("cy", d => lifeExpectancyScale(d.LifeExpectancy)) // y uses lifeExpectancyScale
	.attr("r", d => rScale(d.Population))                  // size by population  
	.attr("fill", d => colorScale(d.Region))
	.attr("stroke", "black")
	.attr("opacity", 0.6);


	// Axis 
	let xTickVals = [1000, 2000, 4000, 8000, 16000, 32000, 64000, 128000];
	let xAxis = d3.axisBottom().scale(incomeScale).tickValues(xTickVals).tickFormat(d3.format("~s"));  
	let yAxis = d3.axisLeft().scale(lifeExpectancyScale);

	svg.append("g")
	.attr("class", "axis x-axis")
	.attr("transform", "translate(0," + (height - padding) + ")")
	.call(xAxis);

	svg.append("g")
	.attr("class", "axis y-axis")
	.attr("transform", "translate(" + padding + ",0)")
	.call(yAxis);

	svg.append("text")
	.attr("class", "x axis-label")
	.attr("x", width - 100)
	.attr("y", height - 40)
	.attr("text-anchor", "middle")
	.text("Income per Person");

	svg.append("text")
	.attr("class", "y axis-label")
	.attr("x", - height / 2 + 170)
	.attr("y", +45)
	.attr("text-anchor", "middle")
	.attr("transform", "rotate(-90)")
	.text("Life Expectancy");



 }


// let promiseObject = d3.csv("data/wealth_health_data.csv")

// console.log(promiseObject)

