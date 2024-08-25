// Forked from https://github.com/jasonrudolph/OctoGAS,
// which is a fork of the original OctoGAS implentation  https://github.com/btoews/OctoGAS

// This script works by matching manually created and managed labels at known paths against
// incoming emails:
// Direct Mention - applied to any notification threads you are directly pinged in
// Author - applied to any notification threads for GitHub issues/PRs/discussions you've authored
// Repo/<owner>/<repo> - applied to any notification threads a the <owner>/<repo> GitHub repository (e.g. Repo/github/my-repo)
// Team/@<organization>/<team> - applied to any notification threads that @-mention the team (e.g. Team/@github/my-team) 

// As this script does not directly manage the labels in your Gmail inbox, it is up to the user
// to create/update/delete labels to affect the functionality


// This implementation will apply labels for all applicable reasons to all threads and does not attempt to
// give preference to any single reason you might be interested in a notification
function labler() {
  var TEAM_LABEL, TEAM_LABEL_REGEX, CACHE, CACHE_EXPIRY, CACHE_VERSION, Label, LABEL_CHUNK_SIZE, MY_TEAMS_REGEX, Message, QUERY, LAST_RUN_KEY, SHOULD_ARCHIVE, Thread, error,
    indexOf = [].indexOf;

  TEAM_LABEL = "Team";
  TEAM_LABEL_REGEX = new RegExp(`^${TEAM_LABEL}/`)

  // Archive your messages after labeling.
  SHOULD_ARCHIVE = false;

  // Private cache so we don't need to process every message every time.
  CACHE = CacheService.getUserCache();
  CACHE_VERSION = 1;
  CACHE_EXPIRY = 60 * 60 * 2;

  LAST_RUN_KEY = "lastRun";
  var lastRun = CACHE.get(LAST_RUN_KEY);

  // The Gmail search to find threads to label
  // only consider threads newer than the last time the script was run
  QUERY = "in:inbox AND ( from:\"notifications@github.com\" OR from:\"noreply@github.com\")";
  if (lastRun) {
    QUERY = `${QUERY} AND newer:${lastRun}`;
  }

  Logger.log(`Running query ${QUERY}`);

  LABEL_CHUNK_SIZE = 100;

  Label = (function() {
    class Label {
      // Load Labels that have been persisted with Gmail.

      // Returns an Array of Labels.
      static loadPersisted() {
        var labels = GmailApp.getUserLabels().map(l => new Label(l.getName(), l));
        // Finds team mentions for my teams and extracts the team name.
        var myTeams = labels.filter(l => l.name.match(TEAM_LABEL_REGEX))
                            .map(l => l.name.replace(TEAM_LABEL_REGEX, ""));
        MY_TEAMS_REGEX = new RegExp(`\\s(${myTeams.join('|')})\\s`);
        return labels;
      }

      // Find or create a nested Label and its parent Labels given its name parts.

      // name_parts - An Array of nested label names.

      // Returns a Label.
      static findOrCreate(name_parts) {
        var name;
        // Make sure the parent label exists.
        if (name_parts.length > 1) {
          this.findOrCreate(name_parts.slice(0, name_parts.length - 1));
        }
        return this.find(name_parts) || new Label(name);
      }

      // Find a label by its name.

      // name - The full String name.

      // Returns a Label or undefined.
      static find(name_parts) {
        var name = name_parts.join("/");
        if (indexOf.call(this.names, name) >= 0) {
          return this.all[name];
        }
      }

      // Apply all Labels to all queued Threads.

      // Returns an array of Thread.id that had labels applied.
      static applyAll() {
        return this.names.reduce((accum, current) => {
          return accum.concat(...this.all[current].apply());
        }, []);
      }

      // Instantiate a Label, creating it on Gmail if it doesn't exist.

      // @name   - The full String name of the label.
      // @_label - The GmailLabel object for this label (optional).

      // Returns nothing
      constructor(name1, _label) {
        this.name = name1;
        this._label = _label;
        this._queue = [];
        this._label || (this._label = GmailApp.createLabel(this.name));
        Label.all[this.name] = this;
        Label.names.push(this.name);
      }

      // Queue a thread to have this label applied.

      // thread - The Thread to apply this label to.

      // Returns nothing.
      queue(thread) {
        if (indexOf.call(this._queue, thread) < 0) {
          return this._queue.push(thread);
        }
      }

      // Apply this label to all queued Threads.

      // Returns an array of Thread.id that had the label applied.
      apply() {
        var threads, applied, chunks;
        threads = this._queue.map(thread => thread._thread);
        if (threads.length) {
          // Label.addToThreads has a maximum argument size of 100
          // `threads` needs to be chunked to ensure no calls are made
          // with more than 100 threads to label
          chunks = Array(Math.ceil(threads.length / LABEL_CHUNK_SIZE))
                    .fill()
                    .map((_,n) => threads.slice(n * LABEL_CHUNK_SIZE, (n + 1) * LABEL_CHUNK_SIZE));
          chunks.forEach(chunk => this._label.addToThreads(chunk));
        }
        applied = this._queue.map(thread => thread.id);
        this._queue = [];
        return applied;
      }

    };

    Label.all = {};

    Label.names = [];

    return Label;

  }).call(this);

  Thread = (function() {
    class Thread {
      // Load threads from a given search query.

      // query - The search query to run.

      // Returns an Array of Threads.
      static loadFromSearch(query) {
        var threads = GmailApp.search(query);
        // Preload all the messages to speed things up.
        GmailApp.getMessagesForThreads(threads);
        return threads.map(t => new Thread(t));
      }

      // Queue all threads to have the appropriate labels applied given our reason
      // for receiving them.

      // Returns nothing.
      static applyActionsForReason() {
        return this.ids.filter(id => !this.all[id].alreadyDone())
                       .map(id => this.all[id].actionsForReason());
      }

      // Load a list of Thread ids that have already been labled. Because the ids
      // are based on the messages in the thread, new messages in a thread will
      // trigger relabeling.

      // Returns nothing.
      static loadDoneFromCache() {
        var cached;
        cached = CACHE.get(this.doneKey);
        if (cached) {
          return this.done = JSON.parse(cached);
        }
      }

      // Save the list of ids that we have already labeled.

      // Returns nothing.
      static dumpDoneToCache() {
        return CACHE.put(this.doneKey, JSON.stringify(this.done), CACHE_EXPIRY);
      }

      // Archive all the messages in every thread.

      // Returns nothing.
      static archiveAll() {
        var threadsToArchive;
        threadsToArchive = (function() {
          return this.ids.filter(id => !Thread.all[id].alreadyDone())
                  .map(id => Thread.all[id]._thread);
        }).call(this);
        return GmailApp.moveThreadsToArchive(threadsToArchive);
      }

      static markReadAll() {
        var results, threadsToMarkRead;
        threadsToMarkRead = this.readThreads.filter(id => !Thread.all[id].alreadyDone())
                                            .map(id => Thread.all[id]._thread);
        GmailApp.markThreadsRead(threadsToMarkRead);
        results = this.readThreads;
        this.readThreads = [];
        return results;
      }

      static markUnreadAll() {
        var results, threadsToMarkUnread;
        threadsToMarkUnread = this.unreadThreads.filter(id => !Thread.all[id].alreadyDone())
                                            .map(id => Thread.all[id]._thread);
        GmailApp.markThreadsUnread(threadsToMarkUnread);
        results = this.unreadThreads;
        this.unreadThreads = [];
        return results;
      }

      // Instantiate a Thread.

      // @_thread - A GmailThread.

      // Returns nothing.
      constructor(_thread) {
        var m;
        this._thread = _thread;
        this.id = this._thread.getId();
        Thread.all[this.id] = this;
        Thread.ids.push(this.id);
        this.messages = (function() {
          var messages = this._thread.getMessages() || [];
          return messages.map(m => new Message(m));
        }).call(this);
      }

      // Determine why we got this message and label the thread accordingly.

      // Returns nothing.
      actionsForReason() {
        var reason, teamNameWithoutOrg;
        reason = this.reason();
        var markUnread = false;

        if (reason.author) {
          this.queueLabel(["Author"]);
          markUnread = true; 
        } 

        if (reason.mention) {
          this.queueLabel(["Direct Mention"]);
          markUnread = true;
        }

        if (reason.team_mention === true) {
          // disable applying the "Team" label
          // this.queueLabel([TEAM_LABEL]); // Unknown team mentioned
        } else if (reason.team_mention) {
          if (this.queueLabel([TEAM_LABEL, reason.team_mention])) {
            markUnread = true;
          }
        }

        if (reason.meta) {
          this.queueLabel(["Meta"]);
        }

        if (reason.watching === true) {
          // disable applying the "Repo" label
          // this.queueLabel(["Repo"]); // Unknown watched repo (maybe?).
        } else if (reason.watching) {
          if (this.queueLabel(["Repo", reason.watching])) {
            markUnread = true;
          }
        }

        if (markUnread) {
          // don't do this right now :shrug:
          //this.queueMarkUnread();
        }
      }

      // Queue this thread to be given a label.

      // name_parts - The Array of parts of the nested label names.

      // Returns true if a label exists and will be added, false otherwise.
      queueLabel(name_parts) {
        var label;
        // replace with Label.find_or_create to create new labels
        label = Label.find(name_parts);
        if (!label) {
          return false;
        }
        label.queue(this);
        return true;
      }

      queueMarkRead() {
        Thread.readThreads.push(this.id);
      }

      queueMarkUnread() {
        Thread.unreadThreads.push(this.id);
      }

      // Get the reason for us receiving this message.

      // Returns an Object where the key is the name of the reason and the value is
      // more information about the reason.
      reason() {
        var i;
        if (this._reason == null && this.messages.length !== 0) {
          i = this.messages.length - 1;
          this._reason = this.messages[i].reason();
          // Let's see if we can find what team was mentioned if this was a team mention.
          while (this._reason.team_mention === true && i >= 0) {
            this._reason = this.messages[i].reason();
            i--;
          }
        }
        return this._reason;
      }

      // Has this thread already been labeled?

      // Returns a bool.
      alreadyDone() {
        return Thread.done.indexOf(this.id) >= 0;
      }

    };

    Thread.all = {};

    Thread.ids = [];

    Thread.readThreads = [];
    Thread.unreadThreads = [];

    Thread.done = [];

    Thread.doneKey = `octogas:v${CACHE_VERSION}:threads_done`;

    return Thread;

  }).call(this);

  Message = (function() {
    class Message {
      // Load all reasons from cache.

      // Returns nothing.
      static loadReasonsFromCache() {
        var j, k, len, reasons, ref, results;
        reasons = CACHE.getAll(this.keys);
        ref = this.keys;
        results = [];
        for (j = 0, len = ref.length; j < len; j++) {
          k = ref[j];
          results.push(this.all[k].loadReason(reasons[k]));
        }
        return results;
      }

      // Dumps all reasons to cache.

      // Returns nothing.
      static dumpReasonsToCache() {
        var j, k, len, reasons, ref;
        reasons = {};
        ref = this.keys;
        for (j = 0, len = ref.length; j < len; j++) {
          k = ref[j];
          if (this.all[k]._reason != null) {
            reasons[k] = JSON.stringify(this.all[k]._reason);
          }
        }
        return CACHE.putAll(reasons, CACHE_EXPIRY);
      }

      // Instantiate a new Message object.

      // Returns nothing.
      constructor(_message) {
        this._message = _message;
        this.id = this._message.getId();
        this.key = `octogas:v${CACHE_VERSION}:message_reason:${this.id}`;
        Message.all[this.key] = this;
        Message.keys.push(this.key);
      }

      // Get the reason for us receiving this message.

      // Returns an Object where the key is the name of the reason and the value is
      // more information about the reason.
      reason() {
        return this._reason || (this._reason = (function() {
          switch (this.headers()['X-GitHub-Reason']) {
            case 'mention':
              return {
                mention: true
              };
            case 'team_mention':
              return {
                team_mention: this.teamMention() || true,
                watching: this.firstNameInHeader('List-ID') || this.firstNameInHeader('List-Id') || true
              };
            case 'author':
              return {
                author: true
              };
            case 'review_requested':
              return {
                team_mention: this.teamMention() || true,
                watching: this.firstNameInHeader('List-ID') || this.firstNameInHeader('List-Id') || true
              };
            default:
              switch (this.from()) {
                case "notifications@github.com":
                  return {
                    watching: this.firstNameInHeader('List-ID') || this.firstNameInHeader('List-Id') || true
                  };
                case "noreply@github.com":
                  return {
                    meta: true
                  };
                default:
                  return {};
              }
          }
        }).call(this));
      }

      // Loads the cached reason from a String.

      // reason - A stringified reason

      // Returns nothing.
      loadReason(reason) {
        if (reason != null) {
          return this._reason = JSON.parse(reason);
        }
      }

      // Finds mentions of any team that I'm on.

      // Returns an string team name or undefined.
      teamMention() {
        var match, message;
        if (!this._teamMention) {
          message = this._message.getPlainBody()
          if(message) {
            match = message.match(MY_TEAMS_REGEX)
            if (match) {
              this._teamMention = match[1]
            } else if (message.match(/@github\/.+?\s/)) {
            }
          }
        }
        return this._teamMention
      }

      // Who is this message from.

      // Returns a String email address.
      from() {
        return this._from || (this._from = this.firstAddressInHeader('From'));
      }

      // Get the email address out of a header field like "From: Foo Bar <foobar@gmail.com>"

      // header - The name of the header to parse.

      // Retruns a String or undefined.
      firstAddressInHeader(header) {
        var ref, ref1;
        return (ref = this.headers()[header]) != null ? (ref1 = ref.match(/.*? <(.*)>/)) != null ? ref1[1] : void 0 : void 0;
      }

      // The the name our of an address header like "From: Foo Bar <foobar@gmail.com>"

      // header - The name of the header to parse.

      // Retruns a String or undefined.
      firstNameInHeader(header) {
        var ref, ref1;
        return (ref = this.headers()[header]) != null ? (ref1 = ref.match(/(.*?) <.*>/)) != null ? ref1[1] : void 0 : void 0;
      }

      // Load the SMTP headers from the raw message into an Object.

      // Returns an Object.
      headers() {
        var j, key, len, line, match, parts, ref, value;
        if (this._headers == null) {
          this._headers = {};
          // Headers and body are separated by double newline.
          parts = this._message.getRawContent().split("\r\n\r\n", 2);
          ref = parts[0].split("\r\n");
          for (j = 0, len = ref.length; j < len; j++) {
            line = ref[j];
            // This line is a continuation of the previous line.
            if (match = line.match(/^\s+(.*)/)) {
              value += " " + match[1];
            } else {
              if ((typeof key !== "undefined" && key !== null) && (typeof value !== "undefined" && value !== null)) {
                // Save the previous line.
                this.setHeader(this._headers, key, value);
              }
              [key, value] = line.split(": ", 2);
            }
          }
          if ((key != null) && (value != null)) {
            // Save the last header.
            this.setHeader(this._headers, key, value);
          }
        }
        return this._headers;
      }

      // Set a header value. If the header is already set, make it an Array.

      // headers - The Object on which to set the header value.
      // key     - The header name.
      // value   - The value to set.

      // Returns nothing.
      setHeader(headers, key, value) {
        if (Array.isArray(headers[key])) {
          return headers[key].push(value);
        } else if (headers[key] != null) {
          return headers[key] = [headers[key], value];
        } else {
          return headers[key] = value;
        }
      }

    };

    Message.all = {};

    Message.keys = [];

    return Message;

  }).call(this);

  var secondsSinceEpoch = (date) => Math.floor(date.getTime() / 1000);

  // Find all GitHub notifications in inbox and label them appropriately.
  Label.loadPersisted();

  Thread.loadFromSearch(QUERY);

  Thread.loadDoneFromCache();

  Message.loadReasonsFromCache();

  try {
    Thread.applyActionsForReason();
    if (SHOULD_ARCHIVE) {
      Thread.archiveAll();
    }
  } catch (error1) {
    error = error1;
    Logger.log(error);
  } finally {
    var threadsToMarkDone;
    threadsToMarkDone = [];
    try {
      var appliedLabel = Label.applyAll();
      var markedRead = Thread.markReadAll();
      var markedUnread = Thread.markUnreadAll();
      threadsToMarkDone = [...appliedLabel, ...markedRead, ...markedUnread];
    } catch (error1) {
      Logger.log(error1);
    } finally {
      var allDone = new Set([...Thread.done, ...threadsToMarkDone]);
      Thread.done = [...allDone];
      Logger.log(`Marked a total of ${Thread.done.length} threads as completed, with ${threadsToMarkDone.length} new threads evaluated`)
      Thread.dumpDoneToCache();
      Message.dumpReasonsToCache();

      // set the last run timestamp as the number of seconds since the epoch start
      var timeStamp = Math.floor(new Date().getTime() / 1000);
      CACHE.put(LAST_RUN_KEY, timeStamp.toString(), CACHE_EXPIRY);
      Logger.log(`Caching ${LAST_RUN_KEY} as ${timeStamp}`);
    }
  }

}
