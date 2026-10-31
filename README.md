# Calendar


A simple static calendar website for BareBones (and possibly other) events.

The calendar is primarily driven by a single json file events.json
which contains two kinds of records:
* Event record which describe one-off or repeated events.
* Change records which update events including specific instances of repeated events.

Repeated events use a simple mechanism adapted from Unix crontab file to specify the repetion pattern.

TODO: explain details.

Frequently used text fragments can be stored in abbrevs.json to keep events.json uncluttered.
