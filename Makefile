test:
	python3 ./cal.py

webserver:
	echo "In the browser, navigate to http://localhost:8000"
	python3 -m http.server 8000
