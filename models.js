const mongoose = require('mongoose');
const { Schema } = mongoose;

const userSchema = new Schema(
  {
    username: { type: String, required: true, unique: true, lowercase: true, trim: true },
    displayName: { type: String, required: true },
    passwordHash: { type: String, required: true },
    role: { type: String, enum: ['user', 'admin'], default: 'user' },
    banned: { type: Boolean, default: false },
    lastSeen: { type: Date },
  },
  { timestamps: true }
);

const questionSchema = new Schema(
  {
    text: { type: String, required: true },
    options: { type: [String], required: true },
    correct: { type: Number, required: true },
    explanation: { type: String, default: '' },
  },
  { _id: false }
);

const quizSchema = new Schema(
  {
    code: { type: String, required: true, unique: true },
    title: { type: String, required: true },
    subtitle: { type: String, default: '' },
    subject: { type: String, default: '' },
    courseCode: { type: String, default: '' },
    durationMinutes: { type: Number, required: true },
    questions: { type: [questionSchema], default: [] },
    questionCount: { type: Number, default: 0 },
    owner: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    ownerName: { type: String, default: 'Admin' },
    official: { type: Boolean, default: false },
    source: { type: String, enum: ['web', 'bot'], default: 'web' },
    attempts: { type: Number, default: 0 },
  },
  { timestamps: true }
);
quizSchema.index({ official: 1, createdAt: -1 });

const attemptSchema = new Schema(
  {
    quiz: { type: Schema.Types.ObjectId, ref: 'Quiz', required: true, index: true },
    user: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    username: { type: String, required: true },
    answers: { type: [Number], default: [] },
    status: { type: String, enum: ['active', 'submitted'], default: 'active' },
    startedAt: { type: Date, required: true },
    endsAt: { type: Date, required: true },
    submittedAt: { type: Date },
    score: { type: Number, default: 0 },
    total: { type: Number, default: 0 },
    auto: { type: Boolean, default: false },
  },
  { timestamps: true }
);
// One running attempt per user per quiz (stops double taps creating duplicates)
attemptSchema.index(
  { user: 1, quiz: 1 },
  { unique: true, partialFilterExpression: { status: 'active' } }
);
attemptSchema.index({ status: 1, endsAt: 1 });

module.exports = {
  User: mongoose.model('User', userSchema),
  Quiz: mongoose.model('Quiz', quizSchema),
  Attempt: mongoose.model('Attempt', attemptSchema),
};
